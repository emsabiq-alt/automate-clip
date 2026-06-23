export function isWorkflowFailureResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "queue_failed") return true;
  return result.status === "no_video_selected" &&
    Number(result.skipped_failed_video_count || 0) > 0;
}
