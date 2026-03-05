import type { ActivityLogger } from './logger.js'

export interface ClientInfo {
  readonly name?: string
  readonly version?: string
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

function summarizeInput(toolName: string, args: Record<string, unknown>): string {
  const parts: string[] = []

  if (args.query) parts.push(`query: "${truncate(String(args.query), 60)}"`)
  if (args.content) parts.push(`content: "${truncate(String(args.content), 40)}"`)
  if (args.thought_id) parts.push(`id: ${String(args.thought_id).slice(0, 8)}...`)
  if (args.limit) parts.push(`limit: ${args.limit}`)
  if (args.source) parts.push(`source: ${args.source}`)
  if (args.min_similarity) parts.push(`min_sim: ${args.min_similarity}`)
  if (args.tags) parts.push(`tags: ${JSON.stringify(args.tags)}`)
  if (args.old_tag) parts.push(`"${args.old_tag}" → "${args.new_tag}"`)

  return parts.length > 0 ? parts.join(', ') : toolName
}

function summarizeOutput(text: string): string {
  try {
    const data = JSON.parse(text)
    const parts: string[] = []

    if (data.total !== undefined) parts.push(`${data.total} results`)
    if (data.id) parts.push(`id: ${String(data.id).slice(0, 8)}...`)
    if (data.title) parts.push(`"${truncate(data.title, 40)}"`)
    if (data.deleted) parts.push('deleted')
    if (data.renamed) parts.push(`renamed "${data.renamed}" → "${data.to}"`)
    if (data.similarity) parts.push(`sim: ${data.similarity}`)

    return parts.length > 0 ? parts.join(', ') : truncate(text, 100)
  } catch {
    return truncate(text, 100)
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

export function wrapToolHandler(
  handler: ToolHandler,
  toolName: string,
  logger: ActivityLogger,
  getClientInfo: () => ClientInfo,
): ToolHandler {
  return async (args) => {
    const start = Date.now()
    const clientInfo = getClientInfo()

    try {
      const result = await handler(args)
      const durationMs = Date.now() - start
      const outputText = result.content[0]?.text ?? ''

      logger.log({
        toolName,
        clientName: clientInfo.name,
        clientVersion: clientInfo.version,
        status: result.isError ? 'error' : 'success',
        durationMs,
        inputSummary: summarizeInput(toolName, args),
        outputSummary: summarizeOutput(outputText),
        errorMessage: result.isError ? truncate(outputText, 200) : undefined,
      }).catch(() => {})

      return result
    } catch (error) {
      const durationMs = Date.now() - start

      logger.log({
        toolName,
        clientName: clientInfo.name,
        clientVersion: clientInfo.version,
        status: 'error',
        durationMs,
        inputSummary: summarizeInput(toolName, args),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      }).catch(() => {})

      throw error
    }
  }
}
