import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class RoomHistoryEventService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async record(event: { type: string; eventId: string; roomId: string; participantId?: string; displayName?: string; messageId?: string; kind?: string; authorName?: string; text?: string; reason?: string; occurredAt: string }) {
    const room = await this.prisma.integrationRoomHistory.findUnique({ where: { roomId: event.roomId }, select: { roomId: true } });
    if (!room || Number.isNaN(Date.parse(event.occurredAt))) return { accepted: false };
    const occurredAt = new Date(event.occurredAt);
    if (event.type === "participant.joined" && event.participantId && event.displayName) await this.prisma.integrationRoomParticipantSession.create({ data: { id: event.eventId, roomId: event.roomId, participantId: event.participantId, displayName: event.displayName, joinedAt: occurredAt } }).catch((e: { code?: string }) => { if (e.code !== "P2002") throw e; });
    if (event.type === "participant.left" && event.participantId) { const session = await this.prisma.integrationRoomParticipantSession.findFirst({ where: { roomId: event.roomId, participantId: event.participantId, leftAt: null }, orderBy: { joinedAt: "desc" } }); if (session) await this.prisma.integrationRoomParticipantSession.update({ where: { id: session.id }, data: { leftAt: occurredAt } }); }
    if (event.type === "chat.message" && event.messageId && event.kind && event.authorName && event.text) await this.prisma.integrationRoomChatMessage.create({ data: { id: event.messageId, roomId: event.roomId, kind: event.kind, participantId: event.participantId, authorName: event.authorName, text: event.text, createdAt: occurredAt } }).catch((e: { code?: string }) => { if (e.code !== "P2002") throw e; });
    if (event.type === "room.closed") await this.prisma.integrationRoomHistory.update({ where: { roomId: event.roomId }, data: { closedAt: occurredAt, closedReason: event.reason ?? "closed" } });
    return { accepted: true };
  }
}