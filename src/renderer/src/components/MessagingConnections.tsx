import { useState, type FormEvent } from "react";
import type { Coworker, DiscordIntegrationStatus, TelegramIntegrationStatus } from "@shared/contracts";

type Configuration = { integrationId?: string; botToken?: string; coworkerId: string };
type Status = TelegramIntegrationStatus | DiscordIntegrationStatus;
type Provider = "Telegram" | "Discord";
type Props = {
  coworkers: Coworker[];
  telegram: TelegramIntegrationStatus[];
  discord: DiscordIntegrationStatus[];
  working: boolean;
  onTelegramConfigure(input: Configuration): Promise<void>;
  onDiscordConfigure(input: Configuration): Promise<void>;
  onTelegramUnpair(id: string): Promise<void>;
  onTelegramDisconnect(id: string): Promise<void>;
  onDiscordUnpair(id: string): Promise<void>;
  onDiscordDisconnect(id: string): Promise<void>;
};

function Editor({ provider, status, coworkers, working, onSave }: {
  provider: Provider; status?: Status; coworkers: Coworker[]; working: boolean;
  onSave(input: Configuration): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const preferredCoworkerId = choice ?? String(status?.integration.config.coworkerId ?? "");
  const coworkerId = coworkers.some(coworker => coworker.id === preferredCoworkerId)
    ? preferredCoworkerId : coworkers[0]?.id ?? "";
  const disconnected = status?.integration.status === "disconnected";
  const conflict = status?.integration.config.connectionLimitConflict === true;
  const action = status ? disconnected ? "Reconnect" : "Edit" : `Add ${provider} bot`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || saving || !coworkerId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...(status ? { integrationId: status.integration.id } : {}),
        coworkerId,
        botToken: String(data.get("botToken") || "") || undefined,
      });
      form.reset();
      setChoice(null);
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }

  if (!open) return <button type="button" className="secondary-button" disabled={working || !coworkers.length} onClick={() => setOpen(true)}>{action}</button>;
  return (
    <form className="form-stack integration-form" aria-label={`${action} ${status?.integration.name ?? "connection"}`} onSubmit={event => void submit(event)}>
      <label>
        <span>{status && !disconnected ? "Replace bot token (optional)" : "Bot token"}</span>
        <input name="botToken" type="password" autoComplete="off" required={!status || (disconnected && !conflict)} placeholder={status && (!disconnected || conflict) ? "Keep the stored token" : "Paste the bot token"} />
      </label>
      <label>
        <span>Linked coworker</span>
        <select name="coworkerId" value={coworkerId} onChange={event => setChoice(event.target.value)} required>
          {coworkers.map(coworker => <option key={coworker.id} value={coworker.id}>{coworker.name} — {coworker.role}</option>)}
        </select>
      </label>
      {status && coworkerId !== status.integration.config.coworkerId ? <p role="note">Moving this bot keeps its pairing and starts fresh conversations for the selected coworker. Existing history stays with the previous coworker.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="messaging-connection-actions">
        <button className="primary-button" disabled={working || saving || !coworkerId}>{status ? disconnected ? "Reconnect bot" : "Save changes" : `Connect ${provider} bot`}</button>
        <button type="button" className="secondary-button" disabled={saving} onClick={() => { setOpen(false); setError(null); setChoice(null); }}>Cancel</button>
      </div>
    </form>
  );
}

function Connection({ provider, status, coworkers, eligibleCoworkers, working, onSave, onUnpair, onDisconnect }: {
  provider: Provider; status: Status; coworkers: Coworker[]; eligibleCoworkers: Coworker[]; working: boolean;
  onSave(input: Configuration): Promise<void>; onUnpair(id: string): Promise<void>; onDisconnect(id: string): Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { integration } = status;
  const telegram = "pairingLink" in status ? status : null;
  const discord = "pairingCode" in status ? status : null;
  const paired = telegram ? typeof integration.config.chatId === "number" : Boolean(integration.config.channelId);
  const owner = coworkers.find(coworker => coworker.id === integration.config.coworkerId);
  async function act(operation: (id: string) => Promise<void>) {
    setBusy(true); setError(null);
    try { await operation(integration.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return (
    <section className="messaging-connection-card" aria-label={`${provider} ${integration.name}`}>
      <div className="messaging-connection-heading">
        <strong>{integration.name} ⇄ {owner?.name ?? "No coworker"}</strong>
          <span aria-label={`${provider} ${integration.status === "connected" || integration.status === "error" ? "connected" : "disconnected"}`}>{provider} · {integration.status === "connected" ? paired ? "Paired" : "Waiting to pair" : integration.status === "error" ? "Connection error" : "Disconnected"}</span>
      </div>
      {paired ? <p>{telegram ? `Chat ${integration.config.chatId}` : [discord?.guildName, discord?.channelName ? `#${discord.channelName}` : `Channel ${integration.config.channelId}`, discord?.threadName].filter(Boolean).join(" · ")}</p> : null}
      {telegram?.pairingLink ? <div className="telegram-pairing"><p>Open the link and tap Start to pair your private chat with this bot.</p><a href={telegram.pairingLink} target="_blank" rel="noreferrer">Pair Telegram chat</a></div> : null}
      {discord?.pairingCode ? <div className="discord-pairing">
        <p>{discord.inviteUrl ? <a href={discord.inviteUrl} target="_blank" rel="noreferrer">Invite this bot to your server</a> : "Invite this bot to your server"}, then paste this code in the channel or thread you want to pair:</p>
        <code className="discord-pairing-code">{discord.pairingCode}</code>
      </div> : null}
      {discord?.intentSettingsUrl ? <p><a href={discord.intentSettingsUrl} target="_blank" rel="noreferrer">Open Message Content Intent settings</a>{discord.messageContentIntentEnabled === false ? " — enable this so the bot can read messages." : null}</p> : null}
      {telegram && integration.status === "error" && typeof integration.config.connectionError === "string" ? <p role="alert">{integration.config.connectionError}</p> : null}
      {integration.config.connectionLimitConflict === true ? <p role="note">This connection was kept as disconnected because its coworker already had an active {provider} connection. Choose a free coworker to reconnect it.</p> : null}
      {discord?.gatewayError ? <p role="alert">{discord.gatewayError}</p> : null}
      {discord?.receiptReactionDenied ? <p>Allow Add Reactions and Read Message History to enable receipt reactions.</p> : null}
      {paired ? <p className="telegram-hint">Messages and replies stay in this bot’s conversations.{discord ? " Mention the bot in the parent channel to start a thread." : " Use /stop to stop work in this conversation."}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <Editor provider={provider} status={status} coworkers={eligibleCoworkers} working={working || busy} onSave={onSave} />
      <div className="messaging-connection-actions">
        {paired ? <button type="button" className="secondary-button" disabled={working || busy} onClick={() => void act(onUnpair)}>Unpair</button> : null}
        {integration.status !== "disconnected" || integration.config.connectionLimitConflict === true ? <button type="button" className="secondary-button" disabled={working || busy} onClick={() => void act(onDisconnect)}>Disconnect</button> : null}
      </div>
    </section>
  );
}

export function MessagingConnections(props: Props) {
  const { coworkers, working } = props;
  const available = (statuses: Status[], current?: Status) => {
    const occupied = new Set(statuses.filter(candidate => candidate.integration.status === "connected" || candidate.integration.status === "error")
      .filter(candidate => candidate.integration.id !== current?.integration.id)
      .map(candidate => candidate.integration.config.coworkerId));
    return coworkers.filter(coworker => !occupied.has(coworker.id));
  };
  const renderEditor = (provider: Provider, statuses: Status[], onSave: (input: Configuration) => Promise<void>) => {
    const candidates = available(statuses);
    return <>
      <Editor provider={provider} coworkers={candidates} working={working} onSave={onSave} />
      {!candidates.length && coworkers.length ? <p role="status">Every coworker already has an active {provider} connection. Disconnect one before adding or reconnecting another.</p> : null}
    </>;
  };
  return (
    <div className="messaging-connections">
      <h2 className="integration-divider">Telegram bots</h2>
      <p>Connect one Telegram bot per coworker and pair one private chat. Telegram and Discord can both be connected to the same coworker; each bot keeps independent conversations.</p>
      {props.telegram.map(status => <Connection key={status.integration.id} provider="Telegram" status={status} coworkers={coworkers} eligibleCoworkers={available(props.telegram, status)} working={working} onSave={props.onTelegramConfigure} onUnpair={props.onTelegramUnpair} onDisconnect={props.onTelegramDisconnect} />)}
      {renderEditor("Telegram", props.telegram, props.onTelegramConfigure)}
      <h2 className="integration-divider">Discord bots</h2>
      <p>Create a bot in the Discord Developer Portal and enable Message Content Intent. Connect one Discord bot per coworker; each bot pairs to one channel and keeps independent conversations.</p>
      {props.discord.map(status => <Connection key={status.integration.id} provider="Discord" status={status} coworkers={coworkers} eligibleCoworkers={available(props.discord, status)} working={working} onSave={props.onDiscordConfigure} onUnpair={props.onDiscordUnpair} onDisconnect={props.onDiscordDisconnect} />)}
      {renderEditor("Discord", props.discord, props.onDiscordConfigure)}
      {!coworkers.length ? <p>Create a coworker before adding a bot.</p> : null}
    </div>
  );
}
