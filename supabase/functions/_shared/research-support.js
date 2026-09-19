// Bounded lexical support filter, NOT semantic entailment or source authentication.
// Only whole-excerpt direct recurring statements are represented by this grammar.
// Flattened charts lose heading/note/condition scope and MUST NOT imply recurrence.
const number = '(\\d{1,3}(?:,\\d{3})+|\\d+)'
const unit = '(miles?|months?|hours?|cycles?)'
const interval = new RegExp(`^${number} ${unit}(?: (or|and) ${number} ${unit})?(, whichever comes first)?[.]?$`, 'i')
const fields = { mile: 'intervalMiles', month: 'intervalMonths', hour: 'intervalHours', cycle: 'intervalCycles' }
// Preserve word order, multiplicity, punctuation and component roles. No synonyms,
// omitted repeated words, token sorting, or task-specific normalization allowlists.
const taskText = value => value.toLowerCase().replace(/\s+/g, ' ').trim()

function parseInterval(value) {
  const match = value.match(interval)
  if (!match) return null
  const result = { dueSemantics: match[6] || match[3]?.toLowerCase() !== 'and' ? 'whichever_first' : 'all' }
  for (const [n, u] of [[match[1], match[2]], [match[4], match[5]]]) {
    if (!n) continue
    const field = fields[u.toLowerCase().replace(/s$/, '')]
    if (result[field] != null) return null
    result[field] = Number(n.replaceAll(',', ''))
  }
  return result
}
function matchesInterval(candidate, parsed) {
  return parsed && candidate.dueSemantics === parsed.dueSemantics && Object.values(fields).every(field =>
    candidate[field] == null ? parsed[field] == null : parsed[field] === candidate[field])
}

export function hasBoundedTaskSupport(candidate, registry) {
  // Severe-use applicability needs a richer condition protocol; do not guess it.
  if (candidate.profile !== 'normal' || !candidate.evidenceIds.length) return false
  // Validate ALL cited excerpts before accepting. Unknown or contradictory cited
  // context is not ignorable just because another citation happens to match.
  // Intentional false negatives include general cadence, charts and explanatory
  // prose. Typed authenticated spans and scope/recurrence evidence are required
  // before those can be safely supported; a longer fuzzy regex is not a remedy.
  return candidate.evidenceIds.every(id => {
    const excerpt = registry.get(id)?.exactExcerpt || ''
    const direct = excerpt.match(/^(Inspect|Adjust|Replace) ([\p{L} /-]+) every (.+)$/iu)
    return Boolean(direct && direct[1].toLowerCase() === candidate.action &&
      taskText(direct[2]) === taskText(candidate.name) && matchesInterval(candidate, parseInterval(direct[3])))
  })
}
