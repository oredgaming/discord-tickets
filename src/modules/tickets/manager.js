const EventEmitter = require('events');
const TicketArchives = require('./archives');
const { MessageEmbed } = require('discord.js');
const { footer } = require('../../utils/discord');

/** Manages tickets */
module.exports = class TicketManager extends EventEmitter {
	/**
	 * Create a TicketManager instance
	 * @param {Client} client
	 */
	constructor(client) {
		super();

		/** The Discord Client */
		this.client = client;

		this.setMaxListeners(this.client.config.max_listeners);

		this.archives = new TicketArchives(this.client);
	}

	/**
	 * Create a new ticket
	 * @param {string} guild_id - ID of the guild to create the ticket in
	 * @param {string} creator_id - ID of the ticket creator (user)
	 * @param {string} category_id - ID of the ticket category
	 * @param {string} [topic] - The ticket topic 
	 */
	async create(guild_id, creator_id, category_id, topic) {
		if (!topic) topic = '';

		let cat_row = await this.client.db.models.Category.findOne({
			where: {
				id: category_id
			}
		});

		if (!cat_row)
			throw new Error('Ticket category does not exist');
		
		let cat_channel = await this.client.channels.fetch(category_id);

		if (cat_channel.children.size >= 50)
			throw new Error('Ticket category has reached child channel limit (50)');

		let number = (await this.client.db.models.Ticket.count({
			where: {
				guild: guild_id
			}
		})) + 1;

		let guild = this.client.guilds.cache.get(guild_id);
		let member = await guild.members.fetch(creator_id);
		let name = cat_row.name_format
			.replace(/{+\s?(user)?name\s?}+/gi, member.displayName)
			.replace(/{+\s?num(ber)?\s?}+/gi, number);

		let t_channel = await guild.channels.create(name, {
			type: 'text',
			topic: `${member}${topic.length > 0 ? ` | ${topic}` : ''}`,
			parent: category_id,
			reason: `${member.user.tag} requested a new ticket channel`
		});

		t_channel.updateOverwrite(creator_id, {
			VIEW_CHANNEL: true,
			READ_MESSAGE_HISTORY: true,
			SEND_MESSAGES: true,
			ATTACH_FILES: true
		}, `Ticket channel created by ${member.user.tag}`);

		let t_row = await this.client.db.models.Ticket.create({
			id: t_channel.id,
			number,
			guild: guild_id,
			category: category_id,
			creator: creator_id,
			topic: topic.length === 0 ? null : this.client.cryptr.encrypt(topic)
		});

		(async () => {
			let settings = await guild.settings;
			const i18n = this.client.i18n.getLocale(settings.locale);

			topic = t_row.topic
				? this.client.cryptr.decrypt(t_row.topic)
				: '';

			if (cat_row.ping instanceof Array && cat_row.ping.length > 0) {
				let mentions = cat_row.ping.map(id => id === 'everyone'
					? '@everyone'
					: id === 'here'
						? '@here'
						: `<@&${id}>`);

				await t_channel.send(mentions.join(', '));
			}

			if (cat_row.image) {
				await t_channel.send(cat_row.image);
			}

			let description = cat_row.opening_message
				.replace(/{+\s?(user)?name\s?}+/gi, member.displayName)
				.replace(/{+\s?(tag|ping|mention)?\s?}+/gi, member.user.toString());
			let embed = new MessageEmbed()
				.setColor(settings.colour)
				.setAuthor(member.user.username, member.user.displayAvatarURL())
				.setDescription(description)
				.setFooter(settings.footer, guild.iconURL());

			if (topic) embed.addField(i18n('commands.new.opening_message.fields.topic'), topic);

			let sent = await t_channel.send(member.user.toString(), embed);
			await sent.pin({ reason: 'Ticket opening message' });

			await t_row.update({
				opening_message: sent.id
			});

			let pinned = t_channel.messages.cache.last();

			if (pinned.system) {
				pinned
					.delete({ reason: 'Cleaning up system message' })
					.catch(() => this.client.log.warn('Failed to delete system pin message'));
			}

			if (cat_row.claiming) {
				await sent.react('🙌');
			}

			let questions;
			if (cat_row.opening_questions) {
				questions = cat_row.opening_questions
					.map((q, index) => `**${index + 1}.** ${q}`)
					.join('\n\n');
			}

			if (cat_row.require_topic && topic.length === 0) {
				let collector_message = await t_channel.send(
					new MessageEmbed()
						.setColor(settings.colour)
						.setTitle('⚠️ ' + i18n('commands.new.request_topic.title'))
						.setDescription(i18n('commands.new.request_topic.description'))
						.setFooter(footer(settings.footer, i18n('collector_expires_in', 120)), guild.iconURL())
				);

				const collector_filter = (message) => message.author.id === t_row.creator;

				let collector = t_channel.createMessageCollector(collector_filter, {
					time: 120000
				});

				collector.on('collect', async (message) => {
					topic = message.content;
					await t_row.update({
						topic: this.client.cryptr.encrypt(topic)
					});
					await t_channel.setTopic(`${member} | ${topic}`, { reason: 'User updated ticket topic' });
					await sent.edit(
						new MessageEmbed()
							.setColor(settings.colour)
							.setAuthor(member.user.username, member.user.displayAvatarURL())
							.setDescription(description)
							.addField(i18n('commands.new.opening_message.fields.topic'), topic)
							.setFooter(settings.footer, guild.iconURL())
					);
					await message.react('✅');
					collector.stop();
				});

				collector.on('end', async () => {
					collector_message
						.delete()
						.catch(() => this.client.log.warn('Failed to delete topic collector message'));
					if (cat_row.opening_questions) {
						await t_channel.send(
							new MessageEmbed()
								.setColor(settings.colour)
								.setDescription(i18n('commands.new.questions', questions))
								.setFooter(settings.footer, guild.iconURL())
						);
					}
				});
			} else {
				if (cat_row.opening_questions) {
					await t_channel.send(
						new MessageEmbed()
							.setColor(settings.colour)
							.setDescription(i18n('commands.new.questions', questions))
							.setFooter(settings.footer, guild.iconURL())
					);
				}
			}
		})();

		this.client.log.info(`${member.user.tag} created a new ticket in "${guild.name}"`);

		this.emit('create', t_row.id, creator_id);

		return t_row;
	}

	/**
	 * Close a ticket
	 * @param {(string|number)} ticket_id - The channel ID, or the ticket number
	 * @param {string?} closer_id - ID of the member who is closing the ticket, or null
	 * @param {string} [guild_id] - The ID of the ticket's guild (used if a ticket number is provided instead of ID)
	 * @param {string} [reason] - The reason for closing the ticket
	 */
	async close(ticket_id, closer_id, guild_id, reason) {
		let t_row = await this.resolve(ticket_id, guild_id);
		if (!t_row) throw new Error(`A ticket with the ID or number "${ticket_id}" could not be resolved`);
		ticket_id = t_row.id;

		this.emit('beforeClose', ticket_id);

		let guild = this.client.guilds.cache.get(t_row.guild);
		let settings = await guild.settings;
		const i18n = this.client.i18n.getLocale(settings.locale);
		let channel = await this.client.channels.fetch(t_row.id);

		if (closer_id) {
			let member = await guild.members.fetch(closer_id);

			await this.archives.updateMember(ticket_id, member);

			if (channel) {
				let description = reason
					? i18n('ticket.closed_by_member_with_reason.description', member.user.toString(), reason)
					: i18n('ticket.closed_by_member.description', member.user.toString());
				await channel.send(
					new MessageEmbed()
						.setColor(settings.success_colour)
						.setAuthor(member.user.username, member.user.displayAvatarURL())
						.setTitle(i18n('ticket.closed.title'))
						.setDescription(description)
						.setFooter(settings.footer, guild.iconURL())
				);

				setTimeout(async () => {
					await channel.delete(`Ticket channel closed by ${member.user.tag}${reason ? `: "${reason}"` : ''}`);
				}, 5000);
			}

			this.client.log.info(`${member.user.tag} closed a ticket (${ticket_id})${reason ? `: "${reason}"` : ''}`);
		} else {
			if (channel) {
				let description = reason
					? i18n('ticket.closed_with_reason.description')
					: i18n('ticket.closed.description');
				await channel.send(
					new MessageEmbed()
						.setColor(settings.success_colour)
						.setTitle(i18n('ticket.closed.title'))
						.setDescription(description)
						.setFooter(settings.footer, guild.iconURL())
				);

				setTimeout(async () => {
					await channel.delete(`Ticket channel closed${reason ? `: "${reason}"` : ''}`);
				}, 5000);
			}

			this.client.log.info(`A ticket was closed (${ticket_id})${reason ? `: "${reason}"` : ''}`);
		}

		let pinned = await channel.messages.fetchPinned();

		await t_row.update({
			open: false,
			closed_by: closer_id || null,
			closed_reason: reason ? this.client.cryptr.encrypt(reason) : null,
			pinned_messages: [...pinned.keys()]
		});

		this.emit('close', ticket_id);
		return t_row;
	}

	/**
	 * 
	 * @param {(string|number)} ticket_id - ID or number of the ticket
	 * @param {string} [guild_id] - The ID of the ticket's guild (used if a ticket number is provided instead of ID)
	 */
	async resolve(ticket_id, guild_id) {
		let t_row;

		if (this.client.channels.resolve(ticket_id)) {
			t_row = await this.client.db.models.Ticket.findOne({
				where: {
					id: ticket_id
				}
			});
		} else {
			t_row = await this.client.db.models.Ticket.findOne({
				where: {
					number: ticket_id,
					guild: guild_id
				}
			});
		}

		return t_row;
	}

};