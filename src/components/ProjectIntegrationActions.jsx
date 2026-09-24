import { buildMyStuffProjectDraft, buildProjectTransferRequest } from '../projectParity'

export function ProjectToMyStuffAction({ projectId, mutationId, onTransferProject, disabled = false }) {
  async function transfer() {
    if (!onTransferProject) return
    if (!confirm('Transfer project to My Stuff? This creates one My Stuff item and imports the current expense snapshot without changing project accounting. No attachments are transferred.')) return
    await onTransferProject(buildProjectTransferRequest(projectId, mutationId))
  }
  return <button className="btn btn-secondary" disabled={disabled || !onTransferProject} onClick={transfer}>Transfer to My Stuff</button>
}

export function MyStuffToProjectAction({ item, onCreateProject, disabled = false }) {
  return <button className="btn btn-secondary" disabled={disabled || !onCreateProject} onClick={() => onCreateProject?.(buildMyStuffProjectDraft(item))}>Create Project from My Stuff</button>
}
