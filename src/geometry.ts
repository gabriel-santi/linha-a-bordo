export const defaultDimension = 60
export const maxDimension = 200

export type Dimensions = { width: number, height: number }
export type GridData<Ink> = Dimensions & { cells: Ink[] }

export function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxDimension
}
