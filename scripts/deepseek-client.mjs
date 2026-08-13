export async function callDeepSeekCompletion({ apiKey, model, prompt, maxTokens, structured = false, fetchImpl = fetch }) {
  let lastEmptyResponse = null
  const attempts = structured ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const retryInstruction = attempt ? '\n\nReturn the JSON object now. Do not emit analysis, markdown, or an empty response.' : ''
    const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          ...(structured ? [{ role: 'system', content: 'Return exactly one valid JSON object and no surrounding prose.' }] : []),
          { role: 'user', content: `${prompt}${retryInstruction}` },
        ],
        max_tokens: maxTokens,
        ...(structured ? { response_format: { type: 'json_object' }, thinking: { type: 'disabled' } } : {}),
      }),
    })
    if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${await response.text()}`)
    const data = await response.json()
    const choice = data.choices?.[0]
    const text = choice?.message?.content
    if (typeof text === 'string' && text.trim()) return { text, data }
    lastEmptyResponse = { finishReason: choice?.finish_reason || 'unknown', completionTokens: Number(data.usage?.completion_tokens) || 0 }
  }
  throw new Error(`DeepSeek returned empty content after ${attempts} attempt${attempts === 1 ? '' : 's'} (finish reason: ${lastEmptyResponse?.finishReason || 'unknown'}, completion tokens: ${lastEmptyResponse?.completionTokens || 0})`)
}
