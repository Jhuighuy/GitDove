import { IconAlertTriangle, IconCornerLeftDown, IconGitCommit } from "@tabler/icons-react";
import { useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { modKey } from "@/lib/api";
import { shortHash } from "@/lib/format";
import { MessageFields } from "./MessageFields";

export interface MessageRequest {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly message: string;
  /** The commits the message is for: one to reword, or several to squash (oldest first). */
  readonly commits: readonly { readonly hash: string; readonly subject: string }[];
  /** E.g. that the commits were pushed already. */
  readonly warning?: string;
}

const useMessageDialog = create<{
  request: (MessageRequest & { resolve: (message: string | null) => void }) | null;
}>()(() => ({ request: null }));

/** Asks for a commit message; resolves to null when cancelled. */
export const editMessage = (request: MessageRequest) =>
  new Promise<string | null>((resolve) => {
    useMessageDialog.getState().request?.resolve(null);
    useMessageDialog.setState({ request: { ...request, resolve } });
  });

export function MessageDialogHost() {
  const request = useMessageDialog((s) => s.request);
  const close = (message: string | null) => {
    request?.resolve(message);
    useMessageDialog.setState({ request: null });
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close(null)}>
      {request && <MessageBody key={request.title} request={request} onDone={close} />}
    </Dialog>
  );
}

function MessageBody({
  request,
  onDone,
}: {
  request: MessageRequest;
  onDone: (message: string | null) => void;
}) {
  const [message, setMessage] = useState(request.message);
  const valid = message.trim().length > 0;
  const submit = () => valid && onDone(message.trim());
  const squash = request.commits.length > 1;

  return (
    <DialogContent className="gap-3 sm:max-w-xl" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        {request.description && <DialogDescription>{request.description}</DialogDescription>}
      </DialogHeader>
      {squash ? (
        <ol className="bg-muted/40 max-h-36 overflow-y-auto rounded-lg border py-1 text-[12px]">
          {request.commits.toReversed().map((c, i) => (
            <li key={c.hash} className="flex items-center gap-2 px-2.5 py-1">
              {i === request.commits.length - 1 ? (
                <IconGitCommit className="text-primary size-3.5 shrink-0" />
              ) : (
                <IconCornerLeftDown className="size-3.5 shrink-0 text-violet-500" />
              )}
              <span className="text-muted-foreground font-mono text-[11px]">
                {shortHash(c.hash)}
              </span>
              <span className="truncate">{c.subject}</span>
            </li>
          ))}
        </ol>
      ) : (
        request.commits[0] && (
          <div className="text-muted-foreground -mt-1 flex items-center gap-2 text-[12px]">
            <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
              {shortHash(request.commits[0].hash)}
            </span>
            <span className="truncate">{request.commits[0].subject}</span>
          </div>
        )
      )}
      <MessageFields
        message={message}
        onChange={setMessage}
        onSubmit={submit}
        autoFocus
        rows={squash ? 10 : 6}
      />
      <DialogFooter className="items-center">
        {request.warning && (
          <p className="text-muted-foreground mr-auto flex items-center gap-1.5 text-[11px]">
            <IconAlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            {request.warning}
          </p>
        )}
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid}>
          {request.confirmLabel}
          <span className="text-[10px] opacity-60">{modKey}↵</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
