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

export function threadKey(
  message: Pick<InboundMessage, "groupId" | "fromNumber">,
): string {
  const groupId = message.groupId.trim();
  if (groupId.length > 0) return groupId;

  const fromNumber = message.fromNumber.trim();
  if (fromNumber.length === 0) {
    throw new Error("An inbound message must have a sender or group ID");
  }
  return fromNumber;
}
