/**
 * Shared "can't reach Omni" banner and detail-page loading skeleton --
 * identical across every load-then-render view in this plugin (list views
 * via ResourceList, ResourceDetail, ClusterCreate). Extracted once
 * duplicated across enough files that SonarCloud's cross-file duplication
 * check flagged it (2026-08-13, PR #5) -- list views have their own,
 * differently-shaped loading skeleton (see ResourceList.tsx), not shared
 * here since it was never actually duplicated against these.
 */
import { Alert, Box, Button, Skeleton } from '@mui/material';

export function ConnectionErrorAlert({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      Can't reach Omni — {message}
    </Alert>
  );
}

/** Loading placeholder for a single-resource detail/form page (breadcrumb + one content block). */
export function DetailLoadingSkeleton() {
  return (
    <Box>
      <Skeleton variant="text" width={300} height={32} sx={{ mb: 2 }} />
      <Skeleton variant="rectangular" height={300} />
    </Box>
  );
}
