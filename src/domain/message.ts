export interface InboundMessage {
  handle: string;
  fromNumber: string;
  toNumber: string;
  sendblueNumber: string;
  content: string;
  mediaUrl?: string;
  service: string;
  groupId: string;
  participants: string[];
  dateSent: number;
  replyTo?: string;
  raw: unknown;
}

/** One conversation per sender. Group chats are not supported and are dropped at ingestion. */
export function threadKey(message: Pick<InboundMessage, "fromNumber">): string {
  const fromNumber = message.fromNumber.trim();
  if (fromNumber.length === 0) throw new Error("An inbound message must have a sender");
  return fromNumber;
}
