import { useEffect, useRef, useState } from "react";
import type {
  Coworker,
  DiscordIntegrationStatus,
  TelegramIntegrationStatus,
} from "@shared/contracts";
import { MessagingConnections } from "./MessagingConnections";

type Props = { coworker: Coworker; onChanged: () => Promise<void> };

export function CoworkerMessagingSettings(props: Props) {
  return <CoworkerMessagingSettingsContent key={props.coworker.id} {...props} />;
}

function CoworkerMessagingSettingsContent({
  coworker,
  onChanged,
}: {
  coworker: Coworker;
  onChanged: () => Promise<void>;
}) {
  const [telegram, setTelegram] = useState<TelegramIntegrationStatus[]>([]);
  const [discord, setDiscord] = useState<DiscordIntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const hasLoaded = useRef(false);

  async function refresh() {
    if (!mounted.current) return;
    const request = ++generation.current;
    const ownerId = coworker.id;
    if (!hasLoaded.current) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const [nextTelegram, nextDiscord] = await Promise.all([
        window.coworker.integrations.telegramStatus(),
        window.coworker.integrations.discordStatus(),
      ]);
      if (!mounted.current || request !== generation.current) return;
      setTelegram(nextTelegram.filter((status) => status.integration.config.coworkerId === ownerId));
      setDiscord(nextDiscord.filter((status) => status.integration.config.coworkerId === ownerId));
      setLoadFailed(false);
      hasLoaded.current = true;
    } catch (loadError) {
      if (!mounted.current || request !== generation.current) return;
      // A failed refresh must not leave rows whose actions target unknown state.
      setTelegram([]);
      setDiscord([]);
      setLoadFailed(true);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      throw loadError;
    } finally {
      if (mounted.current && request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => undefined);
    const unsubscribe = window.coworker.events?.subscribe?.((event) => {
      if (event.type === "entity.changed" && event.entity === "integrations") {
        void refresh().catch(() => undefined);
      }
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe?.();
    };
    // Refresh is intentionally tied to the coworker so an open modal never
    // displays another coworker's connection rows after navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coworker.id]);

  async function runAction(action: () => Promise<unknown>) {
    setWorking(true);
    setError(null);
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      throw actionError;
    } finally {
      setWorking(false);
    }
  }

  return (
    <fieldset className="folder-picker coworker-messaging-settings">
      <legend>Messaging connections</legend>
      <small>
        Configure Telegram and Discord separately for {coworker.name}. These changes save
        independently from the settings above.
      </small>
      {error ? <p className="inline-error" role="alert">Could not update messaging connections: {error}</p> : null}
      {loadFailed ? <button type="button" className="secondary-button" disabled={refreshing} onClick={() => void refresh().catch(() => undefined)}>Retry loading connections</button> : null}
      {loading ? (
        <p role="status">Loading messaging connections…</p>
      ) : (
        <MessagingConnections
          coworkers={[coworker]}
          telegram={telegram}
          discord={discord}
          working={working || refreshing || loadFailed}
          onTelegramConfigure={(input) => runAction(() => window.coworker.integrations.configureTelegram({ ...input, coworkerId: coworker.id }))}
          onDiscordConfigure={(input) => runAction(() => window.coworker.integrations.configureDiscord({ ...input, coworkerId: coworker.id }))}
          onTelegramUnpair={(id) => runAction(() => window.coworker.integrations.unpairTelegram(id))}
          onTelegramDisconnect={(id) => runAction(() => window.coworker.integrations.disconnectTelegram(id))}
          onDiscordUnpair={(id) => runAction(() => window.coworker.integrations.unpairDiscord(id))}
          onDiscordDisconnect={(id) => runAction(() => window.coworker.integrations.disconnectDiscord(id))}
        />
      )}
    </fieldset>
  );
}
