/**
 * 规格化粘贴进来的备注文本，避免「原样粘贴」导致排版杂乱：
 * - CRLF / CR 统一为 LF
 * - 去掉每行行尾空格与制表符
 * - 连续 3 行以上空行折叠为 1 行空行
 * - 去掉开头/结尾的空行及首尾空白
 */
export function normalizeNotes(input: string | null | undefined): string {
  if (!input) return ''

  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let blankRun = 0

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '')
    if (line === '') {
      blankRun += 1
      continue
    }
    if (blankRun > 0) {
      const keep = blankRun >= 3 ? 1 : blankRun
      for (let i = 0; i < keep; i++) out.push('')
      blankRun = 0
    }
    out.push(line)
  }

  return out.join('\n').trim()
}
