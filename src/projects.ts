import { defaultDimension, isDimension, type GridData } from './geometry'

export type Project<Ink> = GridData<Ink> & { number: number, name: string }
type StoredProject<Ink> = Omit<Project<Ink>, 'width' | 'height'> & Partial<Pick<Project<Ink>, 'width' | 'height'>>

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
    return { snapshot, previous: null }
  } catch {
    // If journaling is unavailable, still attempt the IndexedDB write.
    return { snapshot: null, previous }
  }
}

function clearSnapshot(key: string, snapshot: string) {
  try {
    if (localStorage.getItem(key) === snapshot) localStorage.removeItem(key)
  } catch {
    // The IndexedDB transaction has already committed.
  }
}

function readProject<Ink>(stored: StoredProject<Ink>): Project<Ink> {
  return { ...stored, width: stored.width ?? defaultDimension, height: stored.height ?? defaultDimension }
}

function recoverGrid<Ink>(project: Project<Ink>, store: IDBObjectStore, recovered: Map<string, string>) {
  const key = pendingKey(project.number)
  const snapshot = readSnapshot(key)
  if (!snapshot) return

  try {
    const saved = JSON.parse(snapshot)
    const legacy = !('width' in saved) && !('height' in saved)
    if (legacy && (project.width !== defaultDimension || project.height !== defaultDimension)) return

    const { cells } = saved
    const width = legacy ? defaultDimension : saved.width
    const height = legacy ? defaultDimension : saved.height
    if (!isDimension(width) || !isDimension(height) || !Array.isArray(cells) || cells.length !== width * height) return

    Object.assign(project, { width, height, cells })
    store.put(project)
    recovered.set(key, snapshot)
  } catch {
    // Keep the stored grid if the snapshot is invalid.
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
      library.projects = (savedProjects.result as StoredProject<Ink>[]).map(readProject)
      for (const project of library.projects) recoverGrid(project, store, recovered)

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
    const { snapshot, previous } = recordSnapshot(pendingSelection, { number })
    const transaction = db.transaction(settingsStore, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(settingsStore)
    store.get(selectedKey).onsuccess = () => {
      if (!snapshot || readSnapshot(pendingSelection) === snapshot) store.put(number, selectedKey)
      transaction.commit()
    }
    transaction.oncomplete = () => {
      const completed = snapshot ?? previous
      if (completed) clearSnapshot(pendingSelection, completed)
      resolve()
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

function updateProject<Ink>(
  db: IDBDatabase, number: number, fields: Partial<NewProject<Ink>>, snapshot?: { key: string, value: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(projectsStore, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(projectsStore)
    const request = store.get(number)
    request.onsuccess = () => {
      // Recovery or a newer edit may have superseded this write while the transaction waited.
      if (!snapshot || readSnapshot(snapshot.key) === snapshot.value) {
        store.put({ ...request.result, ...fields, number })
      }
      transaction.commit()
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

export function renameProject(db: IDBDatabase, number: number, name: string) {
  return updateProject(db, number, { name })
}

export async function saveProject<Ink>(db: IDBDatabase, number: number, grid: GridData<Ink>) {
  // Journal the entire grid synchronously, even if the write is queued.
  const key = pendingKey(number)
  const { snapshot, previous } = recordSnapshot(key, grid)
  await updateProject(db, number, grid, snapshot ? { key, value: snapshot } : undefined)
  const completed = snapshot ?? previous
  if (completed) clearSnapshot(key, completed)
}
