import type { SomniApi } from './index'

declare global {
  interface Window {
    somni: SomniApi
  }
}
