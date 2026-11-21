export type Project<Ink> = {
  number: number
  name: string
  cells: Ink[]
}

const storeName = 'projects'
const pendingKey = (number: number) => `linha-a-bordo:pending:${number}`

function readPending<Ink>(project: Project<Ink>): { snapshot: string, cells: Ink[] } | null {
  try {
    const snapshot = localStorage.getItem(pendingKey(project.number))
    if (snapshot) {
      const { cells } = JSON.parse(snapshot)
      if (Array.isArray(cells) && cells.length === project.cells.length) return { snapshot, cells }
    }
  } catch {
    // IndexedDB remains available when the pending snapshot cannot be read.
  }
  return null
}

function clearPending(number: number, snapshot: string) {
  try {
    const key = pendingKey(number)
    if (localStorage.getItem(key) === snapshot) localStorage.removeItem(key)
  } catch {
    // The IndexedDB transaction has already committed.
  }
}

export function openProjects(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('linha-a-bordo', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'number', autoIncrement: true })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function latestProject<Ink>(
  db: IDBDatabase,
  initial?: Omit<Project<Ink>, 'number'>,
): Promise<Project<Ink> | null> {
  return new Promise((resolve, reject) => {
    // Read, recover or create under the same lock so startup sees a consistent project.
    const transaction = db.transaction(storeName, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(storeName)
    const latest = store.openCursor(null, 'prev')
    let project: Project<Ink> | null = null
    let recovered: string | undefined

    latest.onsuccess = () => {
      const cursor = latest.result
      if (cursor) {
        const saved: Project<Ink> = cursor.value
        const pending = readPending(saved)
        project = saved
        if (pending) {
          recovered = pending.snapshot
          project = { ...saved, cells: pending.cells }
          cursor.update(project)
          transaction.commit()
        }
      } else if (initial) {
        const insert = store.add(initial)
        insert.onsuccess = () => { project = { ...initial, number: insert.result as number } }
      }
    }

    transaction.oncomplete = () => {
      if (project && recovered) clearPending(project.number, recovered)
      resolve(project)
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

export function saveProject<Ink>(db: IDBDatabase, project: Project<Ink>): Promise<void> {
  return new Promise((resolve, reject) => {
    // Record the edit synchronously in case this document exits before IndexedDB commits.
    let snapshot: string | undefined
    try {
      const revision = crypto.getRandomValues(new Uint32Array(2))
      const key = pendingKey(project.number)
      snapshot = localStorage.getItem(key) ?? undefined
      const next = JSON.stringify({ revision: Array.from(revision), cells: project.cells })
      localStorage.setItem(key, next)
      snapshot = next
    } catch {
      // Still attempt the primary IndexedDB write if this storage is unavailable.
    }

    // Overlapping write transactions run in creation order. put clones the cells immediately.
    const transaction = db.transaction(storeName, 'readwrite', { durability: 'strict' })
    // Request commit in this input handler, before the document can leave.
    transaction.objectStore(storeName).put(project)
    transaction.commit()
    transaction.oncomplete = () => {
      if (snapshot) clearPending(project.number, snapshot)
      resolve()
    }
    transaction.onabort = () => reject(transaction.error)
  })
}
