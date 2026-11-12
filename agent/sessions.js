import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export async function readStoredState(directory) {
  const storage = await openNodeJsonlStorage(directory, ctx, { readOnly: true });
  try {
    const conversations = await storage.scanConversations({}, 1, undefined, ctx);
    const conversation = conversations.items[0];
    if (!conversation) return null;
    const document = await storage.findDocument({ kind: "fd.ask", scope: { kind: "conversation", conversationId: conversation.id } }, "current", ctx);
    if (!document) return null;
    return (await storage.document(document.id, "current", ctx))?.value ?? null;
  } finally {
    await storage.close(ctx);
  }
}
