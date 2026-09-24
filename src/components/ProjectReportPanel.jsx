import PrivateReportPanel from './PrivateReportPanel.jsx'
import { REPORT_SUBJECT_TYPES } from '../myStuff/reports.js'

export default function ProjectReportPanel({ projectId, isPro, onUpgrade }) {
  return <PrivateReportPanel
    subjectType={REPORT_SUBJECT_TYPES.project}
    subjectId={projectId}
    isPro={isPro}
    onUpgrade={onUpgrade}
  />
}