import { activeDefinitionMatchesPreset } from './commonMaintenancePresets.js'
import { buildUpdateMaintenanceDefinitionV2WirePayload } from './payloads.js'

function findActiveDuplicate(definitions, preset) {
  return (Array.isArray(definitions) ? definitions : []).some(definition => activeDefinitionMatchesPreset(definition, preset))
}

export async function addCommonMaintenancePresets({ presets, readDefinitions, createDefinition, mutationIdForPreset, onConfirmed }) {
  const created = []
  const skipped = []
  let definitions = await readDefinitions()

  for (const preset of presets) {
    if (findActiveDuplicate(definitions, preset)) {
      skipped.push(preset.id)
      onConfirmed?.(preset)
      continue
    }

    const mutationId = mutationIdForPreset(preset)
    let createError = null
    try {
      await createDefinition(preset, mutationId)
    } catch (error) {
      createError = error
    }

    definitions = await readDefinitions()
    if (!findActiveDuplicate(definitions, preset)) {
      if (createError) throw createError
      throw new Error(`${preset.name} was not found after saving. Try again with the same selection.`)
    }
    created.push(preset.id)
    onConfirmed?.(preset)
  }

  return { created, skipped }
}

export async function archiveMaintenanceDefinition({ definitionId, mutationId, updateDefinition, readDefinitions, onConfirmed }) {
  const wire = buildUpdateMaintenanceDefinitionV2WirePayload({ definitionId, enabled:false })
  let updateError = null
  try {
    await updateDefinition(wire, mutationId)
  } catch (error) {
    updateError = error
  }

  const definitions = await readDefinitions()
  const archived = (Array.isArray(definitions) ? definitions : [])
    .find(definition => definition.id === definitionId && definition.enabled === false)
  if (!archived) {
    if (updateError) throw updateError
    throw new Error('Maintenance task was not found after archiving. Try again.')
  }
  onConfirmed?.(archived)
  return archived
}
