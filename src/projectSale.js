export function validateProjectSalePrice(project, saleCents) {
  const goalId = project?.goalId ?? project?.goal_id
  if (goalId && saleCents === 0) return 'Enter a sale price greater than zero for a project linked to a goal.'
  return null
}