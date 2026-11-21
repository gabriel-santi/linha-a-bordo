export type Project<Ink> = {
  number: number
  name: string
  cells: Ink[]
}

type NewProject<Ink> = Omit<Project<Ink>, 'number'>
type Library<Ink> = { projects: Project<Ink>[], selected: number | undefined }

const projectsStore = 'projects'
const settingsStore = 'settings'
const selectedKey = 'selected'
const pendingSelection = 'linha-a-bordo:pending-selection'
const pendingKey = (number: number) => `linha-a-bordo:pending:${number}`

function readSnapshot(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function recordSnapshot(key: string, value: object) {
  const previous = readSnapshot(key)
  try {
    const revision = crypto.getRandomValues(new Uint32Array(2))
    const snapshot = JSON.stringify({ revision: Array.from(revision), ...value })
    localStorage.setItem(key, snapshot)
    return snapshot
  } catch {
    // Clear an older snapshot only if the new IndexedDB write commits.
    return previous
  }
}

function clearSnapshot(key: string, snapshot: string) {
  try {
    if (localStorage.getItem(key) === snapshot) localStorage.removeItem(key)
  } catch {
    // The IndexedDB transaction has already committed.
  }
}

function recoverCells<Ink>(project: Project<Ink>, store: IDBObjectStore, recovered: Map<string, string>) {
  const key = pendingKey(project.number)
  const snapshot = readSnapshot(key)
  if (snapshot) {
    try {
      const { cells } = JSON.parse(snapshot)
      if (Array.isArray(cells) && cells.length === project.cells.length) {
        project.cells = cells
        store.put(project)
        recovered.set(key, snapshot)
      }
    } catch {
      // Keep the stored cells if the snapshot is invalid.
    }
  }
}

export function openProjects(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('linha-a-bordo', 2)
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) {
        request.result.createObjectStore(projectsStore, { keyPath: 'number', autoIncrement: true })
      }
      request.result.createObjectStore(settingsStore)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  })
}

export function loadLibrary<Ink>(db: IDBDatabase, first?: NewProject<Ink>): Promise<Library<Ink>> {
  return new Promise((resolve, reject) => {
    // Serialize first-project creation and recover pending snapshots under the same write lock.
    const transaction = db.transaction([projectsStore, settingsStore], 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(projectsStore)
    const settings = transaction.objectStore(settingsStore)
    const savedSelection = settings.get(selectedKey)
    const savedProjects = store.getAll()
    const recovered = new Map<string, string>()
    const library: Library<Ink> = { projects: [], selected: undefined }

    savedProjects.onsuccess = () => {
      library.projects = savedProjects.result
      for (const project of library.projects) recoverCells(project, store, recovered)

      if (library.projects.length === 0 && first) {
        const insert = store.add(first)
        insert.onsuccess = () => {
          const number = insert.result as number
          library.projects = [{ ...first, number }]
          library.selected = number
          settings.put(number, selectedKey)
        }
        return
      }

      const snapshot = readSnapshot(pendingSelection)
      let selected = savedSelection.result
      if (snapshot) {
        try {
          const { number } = JSON.parse(snapshot)
          if (library.projects.some(project => project.number === number)) {
            selected = number
            recovered.set(pendingSelection, snapshot)
          }
        } catch {
          // Use the IndexedDB selection if the snapshot is invalid.
        }
      }
      library.selected = library.projects.find(project => project.number === selected)?.number
        ?? library.projects.at(-1)?.number
      if (library.selected !== undefined && library.selected !== savedSelection.result) {
        settings.put(library.selected, selectedKey)
      }
    }
    transaction.oncomplete = () => {
      for (const [key, snapshot] of recovered) clearSnapshot(key, snapshot)
      resolve(library)
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

export function createProject<Ink>(db: IDBDatabase, project: NewProject<Ink>): Promise<Project<Ink>> {
  return new Promise((resolve, reject) => {
    const previousSelection = readSnapshot(pendingSelection)
    const transaction = db.transaction([projectsStore, settingsStore], 'readwrite', { durability: 'strict' })
    const insert = transaction.objectStore(projectsStore).add(project)
    insert.onsuccess = () => transaction.objectStore(settingsStore).put(insert.result, selectedKey)
    transaction.oncomplete = () => {
      if (previousSelection) clearSnapshot(pendingSelection, previousSelection)
      resolve({ ...project, number: insert.result as number })
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

export function selectProject(db: IDBDatabase, number: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const snapshot = recordSnapshot(pendingSelection, { number })
    const transaction = db.transaction(settingsStore, 'readwrite', { durability: 'strict' })
    transaction.objectStore(settingsStore).put(number, selectedKey)
    transaction.commit()
    transaction.oncomplete = () => {
      if (snapshot) clearSnapshot(pendingSelection, snapshot)
      resolve()
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

function updateProject<Ink>(
  db: IDBDatabase, number: number, fields: Partial<NewProject<Ink>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(projectsStore, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(projectsStore)
    const request = store.get(number)
    request.onsuccess = () => {
      store.put({ ...request.result, ...fields, number })
      transaction.commit()
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

export function renameProject(db: IDBDatabase, number: number, name: string) {
  return updateProject(db, number, { name })
}

export async function saveProject<Ink>(db: IDBDatabase, number: number, cells: Ink[]) {
  // Journal the captured cells synchronously, even if the write is queued.
  const key = pendingKey(number)
  const snapshot = recordSnapshot(key, { cells })
  await updateProject(db, number, { cells })
  if (snapshot) clearSnapshot(key, snapshot)
}
