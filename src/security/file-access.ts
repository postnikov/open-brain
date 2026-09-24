import type { ImportService } from '../import/service.js'

/** No filesystem access is delegated, even through a direct service call. */
export function uploadOnlyImportService(service: ImportService): ImportService {
  const disabled = async (): Promise<never> => { throw new Error('Directory import disabled; upload selected files') }
  return { importFiles: service.importFiles, getProgress: service.getProgress, scanVault: disabled, importVaultFiles: disabled }
}
