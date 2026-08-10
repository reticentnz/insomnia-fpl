import { buildExplanationContext, type ExplanationContext } from './integrations'

export type ExplanationProvider = (prompt:string) => Promise<string>

export function buildGroundedPrompt(context:ExplanationContext, question:string) {
  const data=buildExplanationContext(context,question)
  return [`You are an FPL explanation assistant. Answer the user's question using only the supplied application data. Never invent statistics, fixtures, prices, or recommendations. If the data is insufficient, say so.`, `Question: ${question}`, `Application data: ${JSON.stringify(data)}`].join('\n\n')
}

export async function explainWithProvider(provider:ExplanationProvider, context:ExplanationContext, question:string) {
  return provider(buildGroundedPrompt(context,question))
}
