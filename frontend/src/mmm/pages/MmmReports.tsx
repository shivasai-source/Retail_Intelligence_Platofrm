import { ReportCenterPage } from '../../pages/Reports'
import { MmmShell } from '../components/MmmShell'
import { MMM_BRAND } from '../nav'

/** MMM — REPORTS. TPO's Report Center page, in MMM's shell, over MMM's own
 *  reports: `family="mmm"` narrows the library, its totals, its module list
 *  and Clear all to `mmm-*` modules on the server (app/store/reports.py), so
 *  nothing here can list or delete a TPO report. Reports are generated from
 *  the MMM Insights Hub's Export button (backend/app/mmm/report.py). */
export function MmmReports() {
  return (
    <ReportCenterPage
      family="mmm"
      brandLabel={MMM_BRAND}
      sourceHint="Generate a report from the MMM Insights Hub's Export button."
      shell={(children) => (
        <MmmShell activeKey="reports" page="Reports">
          {children}
        </MmmShell>
      )}
    />
  )
}
