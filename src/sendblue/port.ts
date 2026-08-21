import type { AcceptedSend, MessagingPort } from "../worker.js";
import type { SendblueClient, SendblueResponse } from "./client.js";

function accepted(response: SendblueResponse): AcceptedSend {
  const nested = typeof response.data === "object" && response.data !== null
    ? response.data as Record<string, unknown>
    : undefined;
  const handle = response.message_handle ?? nested?.message_handle;
  const status = response.status ?? nested?.status;
  return {
    ...(typeof handle === "string" ? { messageHandle: handle } : {}),
    ...(typeof status === "string" ? { status } : {}),
  };
}

export function createMessagingPort(client: SendblueClient): MessagingPort {
  return {
    markRead: (input) => client.markRead(input),
    setTyping: (input) => client.sendTypingIndicator(input),
    sendDirect: async (input) => accepted(await client.sendMessage({
      number: input.number,
      fromNumber: input.fromNumber,
      content: input.content,
      mediaUrl: input.mediaUrl,
    })),
    sendReaction: (input) => client.sendReaction(input),
    sendCarousel: async (input) => accepted(await client.sendCarousel({
      number: input.number,
      fromNumber: input.fromNumber,
      mediaUrls: input.mediaUrls,
    })),
    uploadFile: async (path) => ({ mediaUrl: await client.uploadFile(path) }),
  };
}
