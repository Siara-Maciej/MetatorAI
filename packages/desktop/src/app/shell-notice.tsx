/**
 * What an action answered, under the top bar (D5): a refusal stays until it is closed; a
 * confirmation goes by itself after a few seconds.
 */
import { useEffect } from "react";
import { noticeExpired, say, useShellNotice } from "../shared/notice.ts";
import { Notice } from "../ui/notice.tsx";

export function ShellNotice({ shown }: { readonly shown: boolean }) {
  const notice = useShellNotice();
  useEffect(() => {
    if (notice?.tone !== "info") return;
    const t = setTimeout(() => noticeExpired(notice), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  return (
    <Notice
      text={shown ? notice?.text : undefined}
      tone={notice?.tone ?? "error"}
      onClose={() => say(undefined)}
    />
  );
}
