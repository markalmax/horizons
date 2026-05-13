import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { SlackChannelsService } from '../slack-channels/slack-channels.service';
import { SlackService } from '../slack/slack.service';
import { BalanceService } from '../balance/balance.service';

@Injectable()
export class EventsService {
  constructor(
    private prisma: PrismaService,
    private slackChannelsService: SlackChannelsService,
    private slackService: SlackService,
    private balanceService: BalanceService,
  ) {}

  // ── Admin CRUD ──

  async getEvents() {
    return this.prisma.event.findMany({
      orderBy: { startDate: 'asc' },
      include: { _count: { select: { pinnedBy: true } } },
    });
  }

  async getEvent(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: { _count: { select: { pinnedBy: true } } },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  async createEvent(dto: CreateEventDto) {
    return this.prisma.event.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        description: dto.description,
        imageUrl: dto.imageUrl,
        location: dto.location,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        hourCost: dto.hourCost,
        ticketThreshold: dto.ticketThreshold ?? null,
        ticketCost: dto.ticketCost ?? null,
        ticketEnabled: dto.ticketEnabled ?? false,
      },
    });
  }

  async updateEvent(slug: string, dto: UpdateEventDto) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const data: any = { ...dto };
    if (dto.startDate) {
      data.startDate = new Date(dto.startDate);
    }
    if (dto.endDate) {
      data.endDate = new Date(dto.endDate);
    }

    return this.prisma.event.update({
      where: { slug },
      data,
    });
  }

  async deleteEvent(slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    await this.prisma.event.delete({ where: { slug } });
    return { deleted: true, slug };
  }

  // ── User-facing ──

  async getActiveEvents() {
    return this.prisma.event.findMany({
      where: { isActive: true },
      orderBy: { startDate: 'asc' },
    });
  }

  async getPinnedEvent(userId: number) {
    return this.prisma.pinnedEvent.findUnique({
      where: { userId },
      include: {
        event: {
          select: {
            eventId: true,
            slug: true,
            title: true,
            description: true,
            imageUrl: true,
            startDate: true,
            endDate: true,
            hourCost: true,
            isActive: true,
          },
        },
      },
    });
  }

  async setPinnedEvent(userId: number, slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!event.isActive) {
      throw new BadRequestException('Event is not active');
    }

    const result = await this.prisma.pinnedEvent.upsert({
      where: { userId },
      create: { userId, eventId: event.eventId },
      update: { eventId: event.eventId },
      include: {
        event: {
          select: {
            eventId: true,
            slug: true,
            title: true,
            description: true,
            imageUrl: true,
            startDate: true,
            endDate: true,
            hourCost: true,
            isActive: true,
          },
        },
      },
    });

    this.slackChannelsService
      .inviteToSubeventChannel(userId)
      .catch((err) =>
        console.error('[SlackChannels] inviteToSubeventChannel failed:', err),
      );

    return result;
  }

  async removePinnedEvent(userId: number) {
    const pinned = await this.prisma.pinnedEvent.findUnique({
      where: { userId },
    });
    if (!pinned) {
      throw new NotFoundException('No pinned event found');
    }
    await this.prisma.pinnedEvent.delete({ where: { userId } });
    return { removed: true };
  }

  // ── Ticketing ──

  async getTicketStatus(userId: number, slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const hasTicketTxn = await this.prisma.transaction.findUnique({
      where: {
        uniq_user_event_kind: {
          userId,
          eventId: event.eventId,
          kind: 'EventTicket',
        },
      },
      select: { transactionId: true },
    });

    const { balance, totalApprovedHours } =
      await this.balanceService.getUserBalance(userId);

    return {
      slug: event.slug,
      ticketThreshold: event.ticketThreshold,
      ticketCost: event.ticketCost,
      ticketEnabled: event.ticketEnabled,
      hasTicket: !!hasTicketTxn,
      balance,
      approvedHours: Math.round(totalApprovedHours * 10) / 10,
    };
  }

  async buyTicket(userId: number, slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!event.isActive) {
      throw new BadRequestException('Event is not active');
    }
    if (event.ticketCost === null) {
      throw new BadRequestException(
        'This event does not have a ticket for purchase',
      );
    }
    if (!event.ticketEnabled) {
      throw new BadRequestException(
        'Ticket sales are not currently open for this event',
      );
    }

    await this.balanceService.verifyEligibility(userId, 'Event Ticket');

    // Threshold gates eligibility on approved hours earned, not on balance —
    // users may still buy when their balance can't cover the full price
    // (balance is allowed to go negative).
    if (event.ticketThreshold !== null) {
      const { totalApprovedHours } =
        await this.balanceService.getUserBalance(userId);
      if (totalApprovedHours < event.ticketThreshold) {
        throw new BadRequestException(
          `You need ${event.ticketThreshold} approved hours to buy a ticket. You have ${Math.round(totalApprovedHours * 10) / 10}.`,
        );
      }
    }

    let transaction;
    try {
      transaction = await this.prisma.$transaction(async (tx) => {
        const txn = await tx.transaction.create({
          data: {
            userId,
            eventId: event.eventId,
            kind: 'EventTicket',
            itemDescription: `Ticket — ${event.title}`,
            cost: event.ticketCost!,
          },
        });
        await tx.pinnedEvent.upsert({
          where: { userId },
          create: { userId, eventId: event.eventId },
          update: { eventId: event.eventId },
        });
        return txn;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'You already have a ticket for this event',
        );
      }
      throw err;
    }

    this.slackChannelsService
      .inviteToSubeventChannel(userId)
      .catch((err) =>
        console.error('[SlackChannels] inviteToSubeventChannel failed:', err),
      );
    this.sendTicketConfirmation(userId, event.title).catch((err) =>
      console.error('[Events] ticket confirmation Slack DM failed:', err),
    );

    const newBalance = await this.balanceService.getUserBalance(userId);
    return {
      transactionId: transaction.transactionId,
      newBalance: newBalance.balance,
    };
  }

  async getEventAttendees(slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // EventRsvp included so attendees who came in through the legacy two-step
    // flow still show up and their spend is captured in totalSpent.
    const txns = await this.prisma.transaction.findMany({
      where: {
        eventId: event.eventId,
        kind: { in: ['EventRsvp', 'EventTicket'] },
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const byUser = new Map<
      number,
      {
        userId: number;
        email: string;
        firstName: string;
        lastName: string;
        ticketAt: Date | null;
        totalSpent: number;
      }
    >();
    for (const t of txns) {
      const row = byUser.get(t.userId) ?? {
        userId: t.user.userId,
        email: t.user.email,
        firstName: t.user.firstName,
        lastName: t.user.lastName,
        ticketAt: null,
        totalSpent: 0,
      };
      // ticketAt prefers the EventTicket timestamp; fall back to legacy RSVP
      // so users without a new-flow ticket still get a date column.
      if (t.kind === 'EventTicket') row.ticketAt = t.createdAt;
      else if (row.ticketAt === null) row.ticketAt = t.createdAt;
      row.totalSpent = Math.round((row.totalSpent + t.cost) * 10) / 10;
      byUser.set(t.userId, row);
    }
    return Array.from(byUser.values());
  }

  private async sendTicketConfirmation(userId: number, eventTitle: string) {
    const user = await this.prisma.user.findUnique({
      where: { userId },
      select: { slackUserId: true },
    });
    if (!user?.slackUserId) return;
    await this.slackService.sendDirectMessage(
      user.slackUserId,
      `🎟️ Your full ticket for *${eventTitle}* is confirmed. See you there!`,
    );
  }
}
