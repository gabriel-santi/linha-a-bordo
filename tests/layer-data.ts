import { expect, type Page } from '@playwright/test'

export type Cell = string | null
export type Layer = { id: string, visible: boolean, opacity: number, cells: Cell[] }
export type Drawing = { width: number, height: number, activeLayerId: string, layers: Layer[] }
export type Project = Drawing & { number: number, name: string }

export function singleLayer(cells: Cell[], id = expect.any(String)) {
  return { activeLayerId: id, layers: [{ id, visible: true, opacity: 100, cells }] }
}

export function readLibrary(page: Page) {
  return page.evaluate(() => new Promise<{ projects: Project[], selected: number }>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'settings'])
      const projects = tx.objectStore('projects').getAll()
      const selected = tx.objectStore('settings').get('selected')
      tx.oncomplete = () => { db.close(); resolve({ projects: projects.result, selected: selected.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}
