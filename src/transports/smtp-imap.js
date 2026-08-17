// Транспорт по стандартным протоколам: отправка через SMTP, чтение через IMAP.
// Подходит Gmail, Яндексу, Mail.ru, iCloud и любому провайдеру, который пускает
// по паролю приложения. Работает без браузера — секунды вместо минуты на письмо.

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { normalizeOutgoing } = require('../message');

// Общие имена папок → спецпризнаки IMAP. У каждого провайдера папки называются
// по-своему («[Gmail]/Отправленные», «Sent Items»), поэтому ищем по флагу, а не по имени.
const SPECIAL_USE = {
  sent: '\\Sent',
  sentitems: '\\Sent',
  drafts: '\\Drafts',
  archive: '\\Archive',
  junk: '\\Junk',
  junkemail: '\\Junk',
  spam: '\\Junk',
  trash: '\\Trash',
  deleted: '\\Trash',
};

class SmtpImapTransport {
  constructor(account) {
    this.account = account;
    this.transporter = null;
    this.imap = null;
  }

  capabilities() {
    return {
      send: true,
      list: Boolean(this.account.imap && this.account.imap.host),
      fetch: Boolean(this.account.imap && this.account.imap.host),
      search: true,
      html: false, // точка расширения: nodemailer умеет, ядро пока шлёт текст
      attachments: false, // точка расширения
    };
  }

  requirePassword() {
    if (!this.account.pass) {
      const where = this.account.passEnv
        ? `переменная окружения ${this.account.passEnv} пуста`
        : 'в accounts.json не указан passEnv';
      throw new Error(
        `Для ящика «${this.account.name}» нет пароля: ${where}. ` +
          'Положите пароль приложения в .env и повторите.'
      );
    }
  }

  async open() {
    this.requirePassword();
    const { smtp, user, pass } = this.account;
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port || 465,
      secure: smtp.secure !== false,
      auth: { user, pass },
    });
    // Проверяем соединение и пароль сразу: лучше упасть здесь, чем на середине рассылки.
    await this.transporter.verify();
    return this;
  }

  async send(msg, { dryRun = false } = {}) {
    if (!this.transporter) await this.open();
    const m = normalizeOutgoing(msg);

    if (dryRun) {
      // Соединение уже проверено в open(); показываем, что именно ушло бы.
      return {
        id: null,
        dryRun: true,
        preview: `From: ${this.account.address}\nTo: ${m.to.join(', ')}\n` +
          `Subject: ${m.subject}\n\n${m.text}`,
      };
    }

    const info = await this.transporter.sendMail({
      from: this.account.address,
      to: m.to.join(', ') || undefined,
      cc: m.cc.join(', ') || undefined,
      bcc: m.bcc.join(', ') || undefined,
      subject: m.subject,
      text: m.text,
    });
    return { id: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
  }

  async imapClient() {
    if (this.imap) return this.imap;
    this.requirePassword();
    const { imap, user, pass } = this.account;
    if (!imap || !imap.host) {
      throw new Error(`Для ящика «${this.account.name}» не настроен IMAP — чтение недоступно`);
    }
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port || 993,
      secure: imap.secure !== false,
      auth: { user, pass },
      logger: false, // иначе imapflow сыплет отладкой в stdout и портит JSON-вывод
    });
    await client.connect();
    this.imap = client;
    return client;
  }

  // Ищем папку по спецпризнаку, а если провайдер его не отдал — по имени.
  async resolveFolder(client, name) {
    const key = String(name || 'inbox').toLowerCase();
    if (key === 'inbox') return 'INBOX';

    const special = SPECIAL_USE[key];
    const boxes = await client.list();
    if (special) {
      const hit = boxes.find((b) => b.specialUse === special);
      if (hit) return hit.path;
    }
    const byName = boxes.find(
      (b) => b.path.toLowerCase() === key || b.name.toLowerCase() === key
    );
    if (byName) return byName.path;

    throw new Error(
      `Папка «${name}» не найдена. Доступны: ${boxes.map((b) => b.path).join(', ')}`
    );
  }

  async list(opts = {}) {
    const client = await this.imapClient();
    const limit = opts.limit || 20;
    const path = await this.resolveFolder(client, opts.folder);
    const lock = await client.getMailboxLock(path);
    try {
      const criteria = {};
      if (opts.since) criteria.since = opts.since;
      if (opts.unread) criteria.seen = false;
      if (opts.from) criteria.from = opts.from;
      if (opts.search) criteria.body = opts.search;
      if (!Object.keys(criteria).length) criteria.all = true;

      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return [];
      // Свежие письма — в конце списка; берём хвост и разворачиваем от новых к старым.
      const take = uids.slice(-limit).reverse();

      const out = [];
      for await (const item of client.fetch(
        take,
        { uid: true, envelope: true, flags: true, source: Boolean(opts.full) },
        { uid: true }
      )) {
        out.push(await this.toMessage(item, path, opts.full));
      }
      // fetch отдаёт в порядке UID, а не в том, который мы просили.
      out.sort((a, b) => new Date(b.date) - new Date(a.date));
      return out;
    } finally {
      lock.release();
    }
  }

  async toMessage(item, folder, withBody) {
    const env = item.envelope || {};
    const fmt = (list) => (list || []).map((a) => a.address).filter(Boolean);
    const msg = {
      id: String(item.uid),
      account: this.account.name,
      folder,
      from: fmt(env.from)[0] || '',
      fromName: (env.from && env.from[0] && env.from[0].name) || '',
      to: fmt(env.to),
      subject: env.subject || '',
      date: env.date ? new Date(env.date).toISOString() : null,
      unread: !(item.flags && item.flags.has('\\Seen')),
    };
    if (withBody && item.source) {
      const parsed = await simpleParser(item.source);
      msg.text = (parsed.text || '').trim();
      msg.snippet = msg.text.replace(/\s+/g, ' ').slice(0, 200);
    }
    return msg;
  }

  async fetch(id, opts = {}) {
    const client = await this.imapClient();
    const path = await this.resolveFolder(client, opts.folder);
    const lock = await client.getMailboxLock(path);
    try {
      for await (const item of client.fetch(
        [String(id)],
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true }
      )) {
        return await this.toMessage(item, path, true);
      }
      return null;
    } finally {
      lock.release();
    }
  }

  async close() {
    if (this.imap) {
      await this.imap.logout().catch(() => this.imap.close());
      this.imap = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}

module.exports = SmtpImapTransport;
