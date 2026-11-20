export type Project<Ink> = {
  number: number
  name: string
  cells: Ink[]
}

const storeName = 'projects'

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
    // Read and create in the same transaction when two tabs start with an empty profile.
    const transaction = db.transaction(storeName, initial ? 'readwrite' : 'readonly')
    const store = transaction.objectStore(storeName)
    const latest = store.openCursor(null, 'prev')
    let project: Project<Ink> | null = null

    latest.onsuccess = () => {
      const cursor = latest.result
      if (cursor) {
        project = cursor.value
      } else if (initial) {
        const insert = store.add(initial)
        insert.onsuccess = () => { project = { ...initial, number: insert.result as number } }
      }
    }

    transaction.oncomplete = () => resolve(project)
    transaction.onabort = () => reject(transaction.error)
  })
}

export function saveProject<Ink>(db: IDBDatabase, project: Project<Ink>): Promise<void> {
  return new Promise((resolve, reject) => {
    // Overlapping write transactions run in creation order. put clones the cells immediately.
    const transaction = db.transaction(storeName, 'readwrite', { durability: 'strict' })
    transaction.objectStore(storeName).put(project)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}
