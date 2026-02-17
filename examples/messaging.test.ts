/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SatiDB — Comprehensive Example                              ║
 * ║  A Messaging App: Groups → Contacts → Messages               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * This single example demonstrates every SatiDB feature through
 * a realistic schema: users belong to groups, and messages are
 * exchanged between contacts within groups.
 *
 * Two query APIs, both mapping to natural SQL:
 *
 *   1. Fluent Builder  — db.messages.select().where({...}).all()
 *   2. Proxy Callback  — db.query(c => { ... })
 *
 *   bun test examples/messaging.test.ts
 */

import { test, expect } from 'bun:test';
import { SatiDB, z } from '../src/satidb';

// ═══════════════════════════════════════════════════════════════
// Type interfaces (break circular inference for z.lazy)
// ═══════════════════════════════════════════════════════════════

interface Group {
    name: string;
    memberships?: Membership[];
    messages?: Message[];
}

interface Contact {
    name: string;
    email?: string;
    memberships?: Membership[];
    sentMessages?: Message[];
}

interface Membership {
    contactId?: number;
    groupId?: number;
    role?: string;
    contact?: Contact;
    group?: Group;
}

interface Message {
    body: string;
    sentAt?: Date;
    groupId?: number;
    senderId?: number;
    group?: Group;
    sender?: Contact;
}

// ═══════════════════════════════════════════════════════════════
// Schema: Groups, Contacts, Messages, Memberships (M-M junction)
// ═══════════════════════════════════════════════════════════════

const GroupSchema: z.ZodType<Group> = z.object({
    name: z.string(),
    memberships: z.lazy(() => z.array(MembershipSchema)).optional(),
    messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const ContactSchema: z.ZodType<Contact> = z.object({
    name: z.string(),
    email: z.string().optional(),
    memberships: z.lazy(() => z.array(MembershipSchema)).optional(),
    sentMessages: z.lazy(() => z.array(MessageSchema)).optional(),
});

// Junction table: Contact ↔ Group (many-to-many)
const MembershipSchema: z.ZodType<Membership> = z.object({
    contactId: z.number().optional(),
    groupId: z.number().optional(),
    role: z.string().default('member'),
    contact: z.lazy(() => ContactSchema).optional(),
    group: z.lazy(() => GroupSchema).optional(),
});

const MessageSchema: z.ZodType<Message> = z.object({
    body: z.string(),
    sentAt: z.date().default(() => new Date()),
    groupId: z.number().optional(),
    senderId: z.number().optional(),
    group: z.lazy(() => GroupSchema).optional(),
    sender: z.lazy(() => ContactSchema).optional(),
});

// ═══════════════════════════════════════════════════════════════
// Database
// ═══════════════════════════════════════════════════════════════

const db = new SatiDB(':memory:', {
    groups: GroupSchema,
    contacts: ContactSchema,
    memberships: MembershipSchema,
    messages: MessageSchema,
});

// ═══════════════════════════════════════════════════════════════
// 1. INSERT — Seed the database
// ═══════════════════════════════════════════════════════════════

test('seed: insert groups, contacts, memberships, and messages', () => {
    // Groups
    const engineering = db.groups.insert({ name: 'Engineering' });
    const design = db.groups.insert({ name: 'Design' });

    // Contacts
    const alice = db.contacts.insert({ name: 'Alice', email: 'alice@co.dev' });
    const bob = db.contacts.insert({ name: 'Bob', email: 'bob@co.dev' });
    const carol = db.contacts.insert({ name: 'Carol', email: 'carol@co.dev' });

    // Memberships (many-to-many via junction)
    alice.memberships.push({ groupId: engineering.id, role: 'lead' });
    alice.memberships.push({ groupId: design.id, role: 'member' });
    bob.memberships.push({ groupId: engineering.id });
    carol.memberships.push({ groupId: design.id, role: 'lead' });
    carol.memberships.push({ groupId: engineering.id });

    // Messages in Engineering
    db.messages.insert({ body: 'Sprint starts Monday', groupId: engineering.id, senderId: alice.id });
    db.messages.insert({ body: 'PR #42 ready for review', groupId: engineering.id, senderId: bob.id });
    db.messages.insert({ body: 'I will review it', groupId: engineering.id, senderId: carol.id });
    db.messages.insert({ body: 'Merged, thanks!', groupId: engineering.id, senderId: bob.id });

    // Messages in Design
    db.messages.insert({ body: 'New mockups uploaded', groupId: design.id, senderId: carol.id });
    db.messages.insert({ body: 'Looks great!', groupId: design.id, senderId: alice.id });

    expect(db.messages.select().count()).toBe(6);
    expect(db.contacts.select().count()).toBe(3);
    expect(db.memberships.select().count()).toBe(5);
});

// ═══════════════════════════════════════════════════════════════
// 2. FLUENT BUILDER — select().where().orderBy().limit()
// ═══════════════════════════════════════════════════════════════

test('builder: fetch messages in a specific group', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;
    const msgs = db.messages.select()
        .where({ groupId: engineering.id })
        .orderBy('id', 'asc')
        .all();

    expect(msgs.length).toBe(4);
    expect(msgs[0].body).toBe('Sprint starts Monday');
    expect(msgs[3].body).toBe('Merged, thanks!');
});

test('builder: callback WHERE with SQL functions', () => {
    // Case-insensitive search using f.lower()
    const found = db.contacts.select()
        .where((c, f, op) => op.eq(f.lower(c.name), 'alice'))
        .get();

    expect(found).not.toBeNull();
    expect(found!.name).toBe('Alice');
});

test('builder: composable AND / OR', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;

    // Messages from Engineering where sender is Alice OR Bob
    const msgs = db.messages.select()
        .where((c, f, op) => op.and(
            op.eq(c.groupId, engineering.id),
            op.or(op.eq(c.senderId, 1), op.eq(c.senderId, 2)),
        ))
        .all();

    expect(msgs.length).toBe(3);
});

test('builder: pagination', () => {
    const page1 = db.messages.select().orderBy('id', 'asc').limit(3).all();
    const page2 = db.messages.select().orderBy('id', 'asc').limit(3).offset(3).all();

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    expect(page1[2].id).toBeLessThan(page2[0].id);
});

test('builder: count() with filters', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;

    expect(db.messages.select().where({ groupId: engineering.id }).count()).toBe(4);
    expect(db.messages.select().where((c, f, op) => op.gt(c.id, 3)).count()).toBe(3);
});

test('builder: thenable / await', async () => {
    const msgs = await db.messages.select().where({ groupId: 1 });
    expect(msgs.length).toBe(4);
});

// ═══════════════════════════════════════════════════════════════
// 3. PROXY CALLBACK — db.query(c => { ... })
// ═══════════════════════════════════════════════════════════════

test('proxy: join messages with sender name and group name', () => {
    const rows = db.query(c => {
        const { messages: m, contacts: s, groups: g } = c;
        return {
            select: { body: m.body, sender: s.name, group: g.name },
            join: [[m.senderId, s.id], [m.groupId, g.id]],
            where: { [g.name]: 'Engineering' },
            orderBy: { [m.id]: 'asc' },
        };
    });

    expect(rows.length).toBe(4);
    expect((rows[0] as any).sender).toBe('Alice');
    expect((rows[0] as any).group).toBe('Engineering');
    expect((rows[1] as any).sender).toBe('Bob');
});

test('proxy: find all groups a contact belongs to', () => {
    const rows = db.query(c => {
        const { memberships: m, contacts: ct, groups: g } = c;
        return {
            select: { group: g.name, role: m.role },
            join: [[m.contactId, ct.id], [m.groupId, g.id]],
            where: { [ct.name]: 'Alice' },
        };
    });

    expect(rows.length).toBe(2);
    const groups = rows.map((r: any) => r.group).sort();
    expect(groups).toEqual(['Design', 'Engineering']);
});

test('proxy: messages from contacts in a specific group', () => {
    const rows = db.query(c => {
        const { messages: m, memberships: mb, contacts: ct, groups: g } = c;
        return {
            select: { body: m.body, sender: ct.name },
            join: [
                [m.senderId, ct.id],
                [m.groupId, g.id],
                [mb.contactId, ct.id],
            ],
            where: { [g.name]: 'Engineering', [mb.groupId]: { $gt: 0 } },
            orderBy: { [m.id]: 'asc' },
        };
    });

    // All engineering messages from contacts who are members
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => typeof r.sender === 'string')).toBe(true);
});

// ═══════════════════════════════════════════════════════════════
// 4. RELATIONSHIPS — One-to-Many, Belongs-To, Many-to-Many
// ═══════════════════════════════════════════════════════════════

test('one-to-many: contact.sentMessages navigates children', () => {
    const bob = db.contacts.select().where({ name: 'Bob' }).get()!;
    const msgs = bob.sentMessages.find();

    expect(msgs.length).toBe(2);
    expect(msgs.every((m: any) => m.senderId === bob.id)).toBe(true);
});

test('belongs-to: message.sender() traverses back to parent', () => {
    const msg = db.messages.select().where({ body: 'Looks great!' }).get()!;
    const sender = msg.sender();

    expect(sender.name).toBe('Alice');
});

test('many-to-many: group → memberships → contacts', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;
    const members = engineering.memberships.find().map((m: any) => m.contact());
    const names = members.map((c: any) => c.name).sort();

    expect(names).toEqual(['Alice', 'Bob', 'Carol']);
});

test('many-to-many: contact → memberships → groups', () => {
    const carol = db.contacts.select().where({ name: 'Carol' }).get()!;
    const groups = carol.memberships.find().map((m: any) => m.group());
    const names = groups.map((g: any) => g.name).sort();

    expect(names).toEqual(['Design', 'Engineering']);
});

// ═══════════════════════════════════════════════════════════════
// 5. UPDATE & DELETE
// ═══════════════════════════════════════════════════════════════

test('entity.update() persists changes', () => {
    const alice = db.contacts.select().where({ name: 'Alice' }).get()!;
    alice.update({ email: 'alice.new@co.dev' });

    const refetched = db.contacts.select().where({ name: 'Alice' }).get()!;
    expect(refetched.email).toBe('alice.new@co.dev');
});

test('reactive property assignment auto-persists', () => {
    const bob = db.contacts.select().where({ name: 'Bob' }).get()!;
    bob.email = 'bob.updated@co.dev';

    const refetched = db.contacts.select().where({ id: bob.id }).get()!;
    expect(refetched.email).toBe('bob.updated@co.dev');
});

test('delete by id', () => {
    const msg = db.messages.insert({ body: 'temp message', groupId: 1, senderId: 1 });
    const before = db.messages.select().count();

    db.messages.delete(msg.id);

    expect(db.messages.select().count()).toBe(before - 1);
    expect(db.messages.select().where({ id: msg.id }).get()).toBeNull();
});

test('upsert: insert-or-update in one call', () => {
    const g1 = db.groups.upsert({ name: 'Ops' }, { name: 'Ops' });
    const g2 = db.groups.upsert({ name: 'Ops' }, { name: 'Operations' });

    expect(g2.id).toBe(g1.id);
    expect(g2.name).toBe('Operations');
});

// ═══════════════════════════════════════════════════════════════
// 6. SUBSCRIBE — Smart Polling on QueryBuilder
// ═══════════════════════════════════════════════════════════════

test('subscribe: detects new rows via COUNT+MAX(id) fingerprint', async () => {
    const snapshots: number[] = [];

    // Subscribe to engineering messages
    const unsub = db.messages.select()
        .where({ groupId: 1 })
        .subscribe((rows) => {
            snapshots.push(rows.length);
        }, { interval: 50 });

    // Initial call fires immediately → snapshots[0]
    expect(snapshots.length).toBe(1);

    // Insert a new message → fingerprint changes on next poll
    db.messages.insert({ body: 'New task assigned', groupId: 1, senderId: 2 });

    // Wait for the next poll tick
    await new Promise(r => setTimeout(r, 100));

    // Callback should have fired again with the new row
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[snapshots.length - 1]).toBe(snapshots[0] + 1);

    unsub();
});

test('subscribe: does NOT fire when unrelated data changes', async () => {
    let callCount = 0;

    // Subscribe to Design group messages only
    const design = db.groups.select().where({ name: 'Design' }).get()!;
    const unsub = db.messages.select()
        .where({ groupId: design.id })
        .subscribe(() => {
            callCount++;
        }, { interval: 50 });

    // Initial fire
    expect(callCount).toBe(1);

    // Insert into Engineering (different group) — should NOT trigger
    db.messages.insert({ body: 'Irrelevant', groupId: 1, senderId: 1 });
    await new Promise(r => setTimeout(r, 100));

    // callCount should still be 1 because fingerprint of Design didn't change
    expect(callCount).toBe(1);

    unsub();
});

test('subscribe: unsubscribe stops polling', async () => {
    let callCount = 0;

    const unsub = db.messages.select()
        .subscribe(() => { callCount++; }, { interval: 30 });

    expect(callCount).toBe(1);
    unsub();

    // Insert after unsubscribe — callback should NOT fire
    db.messages.insert({ body: 'After unsub', groupId: 1, senderId: 1 });
    await new Promise(r => setTimeout(r, 100));

    expect(callCount).toBe(1);
});
