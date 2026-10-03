import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ChatGPTAccount, ChatGPTAuthStatus, OpenAIAuthMode } from "@shared/chatgpt-auth";
import type {
  AppSettings,
  ConfigureModelResult,
  Conversation,
  Coworker,
  EmailIntegrationMode,
  Integration,
  ModelEndpoint,
  ProviderErrorDiagnostic,
  RemoteModelProvider,
  Skill,
  DiscordIntegrationStatus,
  TelegramIntegrationStatus,
  WebSearchProvider,
} from "@shared/contracts";
import { webSearchProviders } from "@shared/contracts";
import { formatClockDateTime, formatClockTime } from "@shared/time";
import {
  getModelProviderDefinition,
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderDisplayName,
  remoteModelProviderDefinitions,
} from "@shared/model-providers";
import { AppearanceControls } from "../components/AppearanceControls";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { ModelSelector } from "../components/ModelSelector";
import { PageHeader } from "../components/Primitives";
import { readableError } from "../lib/errors";
import { MessagingConnections } from "../components/MessagingConnections";
import chatGPTSignInMark from "../assets/chatgpt-sign-in.svg";
import {
  ChatGPTWelcomeDialog,
  isChatGPTPlanConnected,
} from "../components/ChatGPTPlanIndicator";

export type SettingsTab =
  | "general"
  | "models"
  | "web-search"
  | "skills"
  | "integrations"
  | "archived"
  | "data";

const settingsTabLabels: Record<SettingsTab, string> = {
  general: "General",
  models: "Model Providers",
  "web-search": "Web search",
  skills: "Skills",
  integrations: "Channels",
  archived: "Archived",
  data: "Data",
};

function chatGPTAccountDisplayName(account: Pick<ChatGPTAccount, "label" | "email">): string {
  const email = account.email?.trim();
  // Some saved account labels already include the email; do not repeat it.
  if (!email || account.label.toLocaleLowerCase().includes(email.toLocaleLowerCase())) {
    return account.label;
  }
  return `${account.label} · ${email}`;
}

interface Confirmation {
  eyebrow: string;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function SettingsPage({
  settings,
  integrations,
  modelEndpoints = [],
  skills,
  coworkers,
  conversations = [],
  dataPath,
  version = "development",
  initialTab = "general",
  onChanged,
}: {
  settings: AppSettings;
  integrations: Integration[];
  modelEndpoints?: ModelEndpoint[];
  skills: Skill[];
  coworkers: Coworker[];
  conversations?: Conversation[];
  dataPath: string;
  version?: string;
  initialTab?: SettingsTab;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<"success" | "error">("success");
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({});
  const [unreadableKeys, setUnreadableKeys] = useState<string[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [modelProvider, setModelProvider] = useState<RemoteModelProvider | "add-endpoint">(
    "openrouter",
  );
  const [makeDefaultModel, setMakeDefaultModel] = useState(true);
  const [defaultModelChoice, setDefaultModelChoice] = useState("");
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider>("firecrawl");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [providerErrors, setProviderErrors] = useState<ProviderErrorDiagnostic[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [globalInstructions, setGlobalInstructions] = useState(
    settings.globalOperatingInstructions,
  );
  const [telegramStatuses, setTelegramStatuses] = useState<TelegramIntegrationStatus[]>([]);
  const [discordStatuses, setDiscordStatuses] = useState<DiscordIntegrationStatus[]>([]);
  const [confirmingArchivedDelete, setConfirmingArchivedDelete] = useState<string | null>(null);
  const [chatGPTStatus, setChatGPTStatus] = useState<ChatGPTAuthStatus | null>(null);
  const [chatGPTStatusLoading, setChatGPTStatusLoading] = useState(false);
  const [chatGPTError, setChatGPTError] = useState<string | null>(null);
  const [chatGPTSignInPending, setChatGPTSignInPending] = useState(false);
  const chatGPTStatusRequest = useRef(0);
  const chatGPTSignInGeneration = useRef(0);
  const chatGPTSignInPendingRef = useRef(false);

  // Older test harnesses and app builds can omit the optional bridge while the
  // API-key path remains fully usable. A real bridge always supplies this set.
  const chatGPTBridgeAvailable =
    typeof window.coworker?.integrations?.chatgptStatus === "function" &&
    typeof window.coworker?.integrations?.setOpenAIAuthMode === "function" &&
    typeof window.coworker?.integrations?.chatgptSignIn === "function";

  const knownProviderCards = remoteModelProviderDefinitions
    .filter((provider) => provider.id !== "openai-compatible")
    .sort((left, right) => Number(right.id === "openrouter") - Number(left.id === "openrouter"));
  const addingEndpoint = modelProvider === "add-endpoint";
  const activeProvider = addingEndpoint ? null : modelProvider;
  const selectedEndpoint = activeProvider
    ? modelEndpoints.find((endpoint) => endpoint.id === activeProvider) ?? null
    : null;
  const isEndpointForm = addingEndpoint || selectedEndpoint !== null;
  const activeDefinition = getModelProviderDefinition(
    addingEndpoint ? "openai-compatible" : modelProvider,
  );
  const openAIAuthMode = chatGPTStatus?.mode ?? "api-key";
  const openAIPlanConnected = isChatGPTPlanConnected(chatGPTStatus);
  const openAIActiveAccount = chatGPTStatus?.accounts.find(
    (account) => account.id === chatGPTStatus.activeAccountId,
  );
  // Keep the existing Disconnect action available for an identity whose token expired.
  const openAIHasStoredActiveAccount = Boolean(
    openAIAuthMode === "chatgpt-subscription" &&
      openAIActiveAccount,
  );
  const openAISavedAccounts = chatGPTStatus?.accounts ?? [];
  const openAISignInTargetAccountId =
    chatGPTStatus?.activeAccountId ??
    (openAISavedAccounts.length === 1 ? openAISavedAccounts[0]?.id : undefined);
  const canContinueChatGPTSignIn = Boolean(
    chatGPTStatus &&
      (openAISavedAccounts.length === 0 || openAISignInTargetAccountId),
  );
  const activeConnected = activeProvider
    ? activeProvider === "openai" && chatGPTBridgeAvailable
      ? chatGPTStatusLoading || !chatGPTStatus
        ? false
        : openAIAuthMode === "chatgpt-subscription"
          ? openAIPlanConnected
          : Boolean(credentialStatus[modelProviderCredentialKey(activeProvider)])
      : Boolean(credentialStatus[modelProviderCredentialKey(activeProvider)])
    : false;
  const activeConfigured =
    activeProvider === "openai" ? activeConnected || openAIHasStoredActiveAccount : activeConnected;
  const activeLabel = addingEndpoint
    ? "New endpoint"
    : modelProviderDisplayName(modelProvider, modelEndpoints);

  function providerIsConnected(provider: RemoteModelProvider): boolean {
    if (provider !== "openai" || !chatGPTBridgeAvailable) {
      return Boolean(credentialStatus[modelProviderCredentialKey(provider)]);
    }
    if (!chatGPTStatus) return false;
    return chatGPTStatus.mode === "chatgpt-subscription"
      ? isChatGPTPlanConnected(chatGPTStatus)
      : Boolean(credentialStatus[modelProviderCredentialKey(provider)]);
  }

  function providerStatusLabel(provider: RemoteModelProvider): string {
    if (provider !== "openai" || !chatGPTBridgeAvailable) {
      return credentialStatus[modelProviderCredentialKey(provider)] ? "Connected" : "Not connected";
    }
    if (chatGPTStatusLoading) return "Checking connection…";
    if (!chatGPTStatus) return "Connection unavailable";
    if (chatGPTStatus.mode === "chatgpt-subscription") {
      if (isChatGPTPlanConnected(chatGPTStatus)) return "ChatGPT plan connected";
      if (chatGPTStatus.state === "sign-in-required" && openAIActiveAccount) {
        return "Sign-in required";
      }
      if (openAIActiveAccount?.connected) return "Account needs access";
      if (openAIActiveAccount) return "Reconnect account";
      if (chatGPTStatus.state === "waiting") return "Waiting for sign-in";
      return "Not connected";
    }
    return credentialStatus[modelProviderCredentialKey(provider)] ? "Connected" : "Not connected";
  }

  async function refreshChatGPTStatus() {
    if (typeof window.coworker?.integrations?.chatgptStatus !== "function") return;
    const requestId = ++chatGPTStatusRequest.current;
    setChatGPTStatusLoading(true);
    try {
      const status = await window.coworker.integrations.chatgptStatus();
      if (requestId === chatGPTStatusRequest.current) {
        setChatGPTStatus(status);
        setChatGPTError(null);
      }
    } catch {
      if (requestId === chatGPTStatusRequest.current) {
        setChatGPTError("Could not check your ChatGPT connection. Try again.");
      }
    } finally {
      if (requestId === chatGPTStatusRequest.current) setChatGPTStatusLoading(false);
    }
  }

  function acceptChatGPTStatus(status: ChatGPTAuthStatus) {
    // A completed action wins over any status read that started before it.
    chatGPTStatusRequest.current += 1;
    setChatGPTStatus(status);
    setChatGPTStatusLoading(false);
    setChatGPTError(null);
  }

  async function cancelChatGPTSignIn(updateView = true) {
    const wasPending = chatGPTSignInPendingRef.current;
    const shouldCancel =
      wasPending || chatGPTSignInPending || chatGPTStatus?.state === "waiting";
    chatGPTSignInPendingRef.current = false;
    chatGPTSignInGeneration.current += 1;
    if (updateView) setChatGPTSignInPending(false);
    if (!shouldCancel || typeof window.coworker?.integrations?.chatgptCancelSignIn !== "function") {
      return;
    }
    try {
      const status = await window.coworker.integrations.chatgptCancelSignIn();
      if (updateView) acceptChatGPTStatus(status);
    } catch {
      if (updateView) setChatGPTError("Could not cancel sign-in. Please try again.");
    }
  }

  async function updateOpenAIAuthMode(mode: OpenAIAuthMode) {
    if (typeof window.coworker?.integrations?.setOpenAIAuthMode !== "function") return;
    setWorking(true);
    setChatGPTError(null);
    try {
      const status = await window.coworker.integrations.setOpenAIAuthMode(mode);
      acceptChatGPTStatus(status);
      await onChanged();
    } catch {
      setChatGPTError("Could not change your OpenAI sign-in method. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  async function startChatGPTSignIn(accountId?: string) {
    if (typeof window.coworker?.integrations?.chatgptSignIn !== "function") return;
    const generation = ++chatGPTSignInGeneration.current;
    chatGPTSignInPendingRef.current = true;
    setChatGPTSignInPending(true);
    setChatGPTError(null);
    try {
      const status = await window.coworker.integrations.chatgptSignIn(accountId);
      if (generation !== chatGPTSignInGeneration.current) return;
      chatGPTSignInPendingRef.current = false;
      setChatGPTSignInPending(false);
      acceptChatGPTStatus(status);
      await onChanged();
    } catch {
      if (generation !== chatGPTSignInGeneration.current) return;
      chatGPTSignInPendingRef.current = false;
      setChatGPTSignInPending(false);
      await refreshChatGPTStatus();
      setChatGPTError("We couldn’t finish signing in to ChatGPT. Please try again.");
    }
  }

  async function continueChatGPTSignIn() {
    if (!chatGPTStatus) return;
    if (chatGPTStatus.activeAccountId) {
      await startChatGPTSignIn(chatGPTStatus.activeAccountId);
      return;
    }
    if (openAISavedAccounts.length === 1) {
      // Reconnect the only retained registration instead of creating a second
      // registration for an account that already has a saved identity.
      await selectChatGPTAccount(openAISavedAccounts[0]!.id);
      return;
    }
    if (openAISavedAccounts.length === 0) await startChatGPTSignIn();
  }

  async function selectChatGPTAccount(accountId: string) {
    const account = chatGPTStatus?.accounts.find((candidate) => candidate.id === accountId);
    // Retained records without a live token must be reauthorized against that
    // registration. The account-selection API accepts only connected sessions.
    if (account && !account.connected) {
      await startChatGPTSignIn(account.id);
      return;
    }
    if (typeof window.coworker?.integrations?.chatgptSelectAccount !== "function") return;
    setChatGPTError(null);
    try {
      acceptChatGPTStatus(await window.coworker.integrations.chatgptSelectAccount(accountId));
      await onChanged();
    } catch {
      setChatGPTError("Could not switch ChatGPT accounts. Please try again.");
    }
  }

  async function acknowledgeChatGPTWelcome() {
    if (typeof window.coworker?.integrations?.chatgptAcknowledgeWelcome !== "function") return;
    acceptChatGPTStatus(await window.coworker.integrations.chatgptAcknowledgeWelcome());
  }

  useEffect(() => {
    if (tab !== "models" || !chatGPTBridgeAvailable) return;
    void refreshChatGPTStatus();
    // OAuth can expire while Settings stays open. Integration events refresh
    // only the credential-free account summary shown on this page.
    const unsubscribe =
      typeof window.coworker.events?.subscribe === "function"
        ? window.coworker.events.subscribe((event) => {
            if (event.type === "entity.changed" && event.entity === "integrations") {
              void refreshChatGPTStatus();
            }
          })
        : () => undefined;
    return () => {
      // Ignore a late read after leaving the model settings tab.
      chatGPTStatusRequest.current += 1;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, chatGPTBridgeAvailable]);

  useEffect(
    () => () => {
      // Closing settings while the browser window is open must not leave a
      // pending authorization callback attached to a destroyed view.
      if (
        chatGPTSignInPendingRef.current &&
        typeof window.coworker?.integrations?.chatgptCancelSignIn === "function"
      ) {
        chatGPTSignInPendingRef.current = false;
        chatGPTSignInGeneration.current += 1;
        void window.coworker.integrations.chatgptCancelSignIn().catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    const keys = [
      ...remoteModelProviderDefinitions.flatMap((provider) =>
        getModelProviderDefinition(provider.id).baseUrlMode === "none"
          ? [modelProviderCredentialKey(provider.id)]
          : [
              modelProviderCredentialKey(provider.id),
              modelProviderBaseUrlKey(provider.id),
            ],
      ),
      ...modelEndpoints.flatMap((endpoint) => [
        modelProviderCredentialKey(endpoint.id),
        modelProviderBaseUrlKey(endpoint.id),
      ]),
      "integration:email:resend",
      ...webSearchProviders.map((provider) => `web-search:${provider}`),
    ];
    void Promise.all(
      keys.map(
        async (key) =>
          [key, await window.coworker.integrations.credentialStatus(key)] as const,
      ),
    )
      .then((entries) => {
        setCredentialStatus(
          Object.fromEntries(entries.map(([key, status]) => [key, status.configured])),
        );
        setUnreadableKeys(
          entries.filter(([, status]) => status.needsReentry).map(([key]) => key),
        );
      })
      .catch((loadError) => {
        setNoticeKind("error");
        setNotice(
          `Could not check configured providers: ${
            loadError instanceof Error ? loadError.message : String(loadError)
          }`,
        );
      })
      .finally(() => setCredentialsLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endpoint list identity changes with each snapshot refresh
  }, [integrations, modelEndpoints.map((endpoint) => endpoint.id).join("|")]);

  useEffect(() => {
    const providerIsDefault = settings.defaultModelProvider === modelProvider;
    setMakeDefaultModel(providerIsDefault || !settings.defaultModelProvider);
    setDefaultModelChoice(providerIsDefault ? settings.defaultModelName ?? "" : "");
  }, [modelProvider, settings.defaultModelName, settings.defaultModelProvider]);

  useEffect(() => {
    setGlobalInstructions(settings.globalOperatingInstructions);
  }, [settings.globalOperatingInstructions]);

  // Errors stay until the next action so they can be read; confirmations fade on their own.
  useEffect(() => {
    if (!notice || noticeKind !== "success") return;
    const timer = setTimeout(() => setNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [notice, noticeKind]);

  function openTab(next: SettingsTab) {
    if (next !== "models") void cancelChatGPTSignIn();
    setTab(next);
    setNotice(null);
  }

  useEffect(() => {
    if (tab === "data") void refreshProviderErrors();
  }, [tab]);

  useEffect(() => {
    if (tab !== "integrations") return;
    void window.coworker.integrations.telegramStatus()
      .then(setTelegramStatuses)
      .catch(() => setTelegramStatuses([]));
    void window.coworker.integrations.discordStatus()
      .then(setDiscordStatuses)
      .catch(() => setDiscordStatuses([]));
    // Refetches whenever a snapshot refresh reports integration changes, so
    // pairing completed from Telegram or Discord appears without a manual reload.
  }, [tab, integrations]);

  async function refreshProviderErrors() {
    setDiagnosticsLoading(true);
    try {
      setProviderErrors(await window.coworker.diagnostics.listProviderErrors(50));
    } catch (loadError) {
      setNoticeKind("error");
      setNotice(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function copyProviderReport() {
    try {
      const result = await window.coworker.diagnostics.copyProviderReport();
      setNoticeKind("success");
      setNotice(
        result.count > 0
          ? `Copied a redacted report with ${result.count} provider error${result.count === 1 ? "" : "s"}.`
          : "Copied an empty provider report.",
      );
    } catch (copyError) {
      setNoticeKind("error");
      setNotice(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }

  async function exportSupportBundle() {
    try {
      const path = await window.coworker.diagnostics.exportSupportBundle();
      if (!path) return;
      setNoticeKind("success");
      setNotice(`Diagnostics ZIP saved to ${path}`);
    } catch (exportError) {
      setNoticeKind("error");
      setNotice(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function exportDataBackup() {
    try {
      const path = await window.coworker.app.exportDataBackup();
      if (!path) return;
      setNoticeKind("success");
      setNotice(`Complete data backup saved to ${path}`);
    } catch (exportError) {
      setNoticeKind("error");
      setNotice(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function patchSettings(patch: Partial<AppSettings>) {
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.app.updateSettings(patch);
      await onChanged();
    } catch (settingsError) {
      setNoticeKind("error");
      setNotice(readableError(settingsError));
    } finally {
      setWorking(false);
    }
  }

  async function saveGlobalInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.app.updateSettings({
        globalOperatingInstructions: globalInstructions.trim(),
      });
      await onChanged();
      setNoticeKind("success");
      setNotice(
        "Global operating instructions saved. Coworkers will use them on the next request.",
      );
    } catch (saveError) {
      setNoticeKind("error");
      setNotice(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function configureModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "").trim();
    const baseUrl = String(data.get("baseUrl") ?? "").trim();
    const endpointName = String(data.get("endpointName") ?? "").trim();
    if (
      modelProvider === "openai" &&
      chatGPTBridgeAvailable &&
      openAIAuthMode === "chatgpt-subscription" &&
      !openAIPlanConnected
    ) {
      setChatGPTError("Connect a ChatGPT account before saving these settings.");
      return;
    }
    setWorking(true);
    setNotice(null);
    try {
      const defaultModelName =
        makeDefaultModel && defaultModelChoice ? defaultModelChoice : undefined;
      let result: ConfigureModelResult;
      let savedProvider: RemoteModelProvider;
      if (modelProvider === "add-endpoint") {
        const added = await window.coworker.integrations.addModelEndpoint({
          name: endpointName,
          baseUrl,
          apiKey: apiKey || undefined,
          defaultModelName,
        });
        result = added;
        savedProvider = added.provider;
      } else {
        result = await window.coworker.integrations.configureModel({
          provider: modelProvider,
          apiKey: apiKey || undefined,
          authMode: modelProvider === "openai" && chatGPTBridgeAvailable
            ? openAIAuthMode
            : undefined,
          baseUrl: baseUrl || undefined,
          defaultModelName,
          endpointName: endpointName || undefined,
        });
        savedProvider = modelProvider;
      }
      const savedLabel =
        endpointName || modelProviderDisplayName(savedProvider, modelEndpoints);
      // Subscription sign-in is kept separately from saved API keys, so saving
      // plan-backed defaults must not make an inactive key look connected.
      if (!(savedProvider === "openai" && openAIAuthMode === "chatgpt-subscription")) {
        setCredentialStatus((current) => ({ ...current, [result.key]: true }));
      }
      let appliedDefault = result.defaultApplied ? defaultModelChoice : "";
      if (makeDefaultModel && !result.defaultApplied && result.models[0]) {
        // First-time connection: the model list only became known during this
        // save, so apply the first available model and let the user adjust it.
        appliedDefault = result.models[0].id;
        await window.coworker.app.updateSettings({
          defaultModelProvider: savedProvider,
          defaultModelName: appliedDefault,
        });
        setDefaultModelChoice(appliedDefault);
      }
      await onChanged();
      if (modelProvider === "add-endpoint") setModelProvider(savedProvider);
      form.reset();
      setNoticeKind("success");
      setNotice(
        appliedDefault
          ? `${savedLabel} settings saved. ${savedLabel} · ${appliedDefault} is now the global default model.`
          : `${savedLabel} settings saved.`,
      );
    } catch (configureError) {
      setNoticeKind("error");
      setNotice(
        configureError instanceof Error ? configureError.message : String(configureError),
      );
    } finally {
      setWorking(false);
    }
  }

  function confirmRemoveEndpoint(endpoint: ModelEndpoint) {
    setConfirmation({
      eyebrow: "Model Providers",
      title: `Remove “${endpoint.name}”?`,
      body: <p>Its address and any saved key are removed from this computer.</p>,
      confirmLabel: "Remove endpoint",
      busyLabel: "Removing…",
      onConfirm: async () => {
        await window.coworker.integrations.removeModelEndpoint(endpoint.id);
        setModelProvider("openrouter");
        await onChanged();
        setConfirmation(null);
        setNoticeKind("success");
        setNotice(`${endpoint.name} was removed.`);
      },
    });
  }

  function confirmDisconnectModel(provider: RemoteModelProvider) {
    const label = modelProviderDisplayName(provider, modelEndpoints);
    const disconnectingChatGPT =
      provider === "openai" && openAIAuthMode === "chatgpt-subscription";
    const dependents = coworkers
      .filter((coworker) => coworker.modelProvider === provider)
      .map((coworker) => coworker.name);
    setConfirmation({
      eyebrow: "Model Providers",
      title: `Disconnect ${label}?`,
      body: (
        <ul className="confirm-list">
          <li>
            {disconnectingChatGPT
              ? "This ChatGPT account will be disconnected from this computer."
              : getModelProviderDefinition(provider).apiKeyRequired
                ? "Its saved API key is removed from this computer."
                : "Its saved connection is removed from this computer."}
          </li>
          {dependents.length > 0 ? (
            <li>
              {new Intl.ListFormat(undefined, { type: "conjunction" }).format(dependents)} will
              stop working until you reconnect {label} or give them another model.
            </li>
          ) : null}
          {settings.defaultModelProvider === provider ? (
            <li>{label} will no longer be the global default model.</li>
          ) : null}
        </ul>
      ),
      confirmLabel: "Disconnect",
      busyLabel: "Disconnecting…",
      onConfirm: async () => {
        const result = await window.coworker.integrations.disconnectModel(provider);
        if (!disconnectingChatGPT) {
          setCredentialStatus((current) => ({
            ...current,
            [modelProviderCredentialKey(provider)]: false,
            [modelProviderBaseUrlKey(provider)]: false,
          }));
        } else if (typeof window.coworker.integrations.chatgptStatus === "function") {
          await refreshChatGPTStatus();
        }
        await onChanged();
        setConfirmation(null);
        setNoticeKind("success");
        setNotice(
          disconnectingChatGPT && result?.revocationConfirmed === false
            ? "ChatGPT was disconnected on this computer, but sign-out could not be confirmed in ChatGPT."
            : `${disconnectingChatGPT ? "ChatGPT" : label} was disconnected.`,
        );
      },
    });
  }

  async function configureEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const mode = String(data.get("mode")) as EmailIntegrationMode;
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.integrations.configureEmail({
        name: mode === "local-outbox" ? "Local outbox" : "Resend",
        mode,
        apiKey: String(data.get("apiKey") || "") || undefined,
        fromAddress: String(data.get("fromAddress") || "") || undefined,
      });
      await onChanged();
      setNoticeKind("success");
      setNotice("Email integration updated.");
    } finally {
      setWorking(false);
    }
  }

  async function saveTelegramConnection(input: { integrationId?: string; botToken?: string; coworkerId: string }) {
    const status = await window.coworker.integrations.configureTelegram(input);
    setTelegramStatuses((current) => current.some((item) => item.integration.id === status.integration.id) ? current.map((item) => item.integration.id === status.integration.id ? status : item) : [...current, status]);
    await onChanged();
  }

  async function saveDiscordConnection(input: { integrationId?: string; botToken?: string; coworkerId: string }) {
    const status = await window.coworker.integrations.configureDiscord(input);
    setDiscordStatuses((current) => current.some((item) => item.integration.id === status.integration.id) ? current.map((item) => item.integration.id === status.integration.id ? status : item) : [...current, status]);
    await onChanged();
  }

  async function refreshMessagingStatuses() {
    const [telegram, discord] = await Promise.all([window.coworker.integrations.telegramStatus(), window.coworker.integrations.discordStatus()]);
    setTelegramStatuses(telegram);
    setDiscordStatuses(discord);
    await onChanged();
  }

  async function runMessagingAction(action: () => Promise<unknown>) {
    setWorking(true); setNotice(null);
    try { await action(); await refreshMessagingStatuses(); setNoticeKind("success"); setNotice("Messaging connection updated."); }
    catch (error) { setNoticeKind("error"); setNotice(error instanceof Error ? error.message : String(error)); throw error; }
    finally { setWorking(false); }
  }


  async function configureWebSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = webSearchProvider;
    setWorking(true);
    setNotice(null);
    try {
      const result = await window.coworker.integrations.configureWebSearch({
        provider,
        apiKey: String(data.get("apiKey") ?? ""),
      });
      setCredentialStatus((current) => ({ ...current, [result.key]: true }));
      form.reset();
      setNoticeKind("success");
      setNotice(`${providerLabel(provider)} search key stored securely.`);
    } catch (configureError) {
      setNoticeKind("error");
      setNotice(configureError instanceof Error ? configureError.message : String(configureError));
    } finally {
      setWorking(false);
    }
  }

  function confirmRemoveSearchKey(provider: WebSearchProvider) {
    const label = providerLabel(provider);
    const otherKeys = webSearchProviders.filter(
      (other) => other !== provider && credentialStatus[`web-search:${other}`],
    ).length;
    setConfirmation({
      eyebrow: "Web search",
      title: `Remove the ${label} key?`,
      body: (
        <p>
          {otherKeys > 0
            ? `Web search keeps working with your other saved ${otherKeys === 1 ? "key" : "keys"}.`
            : "Web search will use Firecrawl's free tier, which has a daily limit."}
        </p>
      ),
      confirmLabel: "Remove key",
      busyLabel: "Removing…",
      onConfirm: async () => {
        await window.coworker.integrations.disconnectWebSearch(provider);
        setCredentialStatus((current) => ({ ...current, [`web-search:${provider}`]: false }));
        setConfirmation(null);
        setNoticeKind("success");
        setNotice(
          otherKeys > 0
            ? `${label} key removed.`
            : `${label} key removed. Web search now uses Firecrawl's free tier.`,
        );
      },
    });
  }

  async function discardUnreadableCredentials() {
    setWorking(true);
    setNotice(null);
    try {
      await Promise.all(
        unreadableKeys.map((key) => window.coworker.integrations.removeCredential(key)),
      );
      const discarded = unreadableKeys.length;
      setUnreadableKeys([]);
      setNoticeKind("success");
      setNotice(
        `Discarded ${discarded} unreadable credential${discarded === 1 ? "" : "s"}. Save a new key whenever you need that provider again.`,
      );
    } catch (discardError) {
      setNoticeKind("error");
      setNotice(discardError instanceof Error ? discardError.message : String(discardError));
    } finally {
      setWorking(false);
    }
  }

  async function installSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setWorking(true);
    setNotice(null);
    try {
      const skill = await window.coworker.skills.installFromUrl(String(data.get("url")));
      form.reset();
      await onChanged();
      setNoticeKind("success");
      setNotice(`${skill.name} is now available to every coworker configuration.`);
    } catch (installError) {
      setNoticeKind("error");
      setNotice(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setWorking(false);
    }
  }

  async function uploadSkill(file: File | undefined) {
    if (!file) return;
    setWorking(true);
    setNotice(null);
    try {
      const isPackage = /\.(?:skill|zip)$/i.test(file.name);
      if (!isPackage && !/\.md$/i.test(file.name)) {
        throw new Error("Upload skill.md, a .skill package, or a .zip package.");
      }
      if (file.size > (isPackage ? 10_000_000 : 1_000_000)) {
        throw new Error(isPackage ? "Skill packages must be 10 MB or smaller." : "Skill files must be 1 MB or smaller.");
      }
      const skill = isPackage
        ? await window.coworker.skills.installFromPackage(
            file.name,
            bytesToBase64(await file.arrayBuffer()),
          )
        : await window.coworker.skills.installFromContent(await file.text());
      await onChanged();
      setNoticeKind("success");
      setNotice(
        coworkers.length
          ? `${skill.name} was installed. Enable it for the coworkers below that should use it.`
          : `${skill.name} was installed and is available for future coworker configuration.`,
      );
    } catch (uploadError) {
      setNoticeKind("error");
      setNotice(readableError(uploadError));
    } finally {
      setWorking(false);
    }
  }

  async function toggleCoworkerSkill(coworker: Coworker, skill: Skill, enabled: boolean) {
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.coworkers.update(coworker.id, {
        enabledSkillIds: enabled
          ? [...coworker.enabledSkillIds, skill.id]
          : coworker.enabledSkillIds.filter((id) => id !== skill.id),
      });
      await onChanged();
    } catch (toggleError) {
      setNoticeKind("error");
      setNotice(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setWorking(false);
    }
  }

  function confirmRemoveSkill(skill: Skill) {
    setConfirmation({
      eyebrow: "Skills",
      title: `Remove the “${skill.name}” skill?`,
      body: <p>It is removed for every coworker that uses it.</p>,
      confirmLabel: "Remove skill",
      busyLabel: "Removing…",
      onConfirm: async () => {
        await window.coworker.skills.remove(skill.id);
        await onChanged();
        setConfirmation(null);
        setNoticeKind("success");
        setNotice(`${skill.name} was removed.`);
      },
    });
  }

  async function restoreArchivedConversation(conversation: Conversation) {
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.conversations.restore(conversation.id);
      await onChanged();
      setNoticeKind("success");
      setNotice(`“${conversation.title}” was restored.`);
    } catch (restoreError) {
      setNoticeKind("error");
      setNotice(restoreError instanceof Error ? restoreError.message : String(restoreError));
    } finally {
      setWorking(false);
    }
  }

  async function deleteArchivedConversation(conversation: Conversation) {
    if (confirmingArchivedDelete !== conversation.id) {
      setConfirmingArchivedDelete(conversation.id);
      return;
    }
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.conversations.remove(conversation.id);
      await onChanged();
      setNoticeKind("success");
      setNotice(`“${conversation.title}” was permanently deleted.`);
    } catch (removeError) {
      setNoticeKind("error");
      setNotice(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setConfirmingArchivedDelete(null);
      setWorking(false);
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="Workroom controls"
        title="Settings"
        description="Manage local behavior, model access, channels, and data."
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {(Object.keys(settingsTabLabels) as SettingsTab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => openTab(item)}>
              {settingsTabLabels[item]}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {unreadableKeys.length > 0 ? (
            <div className="settings-notice error" role="alert">
              <p>
                {unreadableKeys.length === 1
                  ? "1 saved credential can no longer be decrypted because it was encrypted under the app's previous name:"
                  : `${unreadableKeys.length} saved credentials can no longer be decrypted because they were encrypted under the app's previous name:`}
              </p>
              <ul className="unreadable-credential-list">
                {unreadableKeys.map((key) => {
                  const location = credentialLocation(key);
                  return (
                    <li key={key}>
                      <strong>{location.label}</strong>
                      <button
                        className="text-button"
                        onClick={() => openTab(location.tab)}
                        type="button"
                      >
                        Open {settingsTabLabels[location.tab]}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p>
                Save a new key to replace it, or discard it if you no longer use that provider.
              </p>
              <button
                className="ghost-button"
                disabled={working}
                onClick={() => void discardUnreadableCredentials()}
                type="button"
              >
                Discard unreadable {unreadableKeys.length === 1 ? "credential" : "credentials"}
              </button>
            </div>
          ) : null}
          {notice ? (
            <div
              className={noticeKind === "error" ? "settings-notice error" : "settings-notice"}
              role={noticeKind === "error" ? "alert" : "status"}
            >
              {notice}
            </div>
          ) : null}
          {tab === "general" ? (
            <section className="settings-section">
              <h2>General Settings</h2>
              <div className="settings-rows">
                <label className="settings-row">
                  <span>
                    <strong>Run in the background</strong>
                    <small>Closing the window keeps coworkers and schedules available in the tray.</small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.runInBackground}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ runInBackground: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
                <label className="settings-row">
                  <span>
                    <strong>Launch at login</strong>
                    <small>Start this profile when you sign in (installed macOS/Windows app). The CLI can select headless startup; this switch preserves that mode.</small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.launchAtLogin}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ launchAtLogin: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
                <label className="settings-row">
                  <span>
                    <strong>Show model reasoning</strong>
                    <small>
                      Display a collapsible “Thinking” block in chats when a model streams its
                      reasoning before answering.
                    </small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.showReasoning}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ showReasoning: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
              </div>
              <AppearanceControls
                disabled={working}
                onChange={(patch) => void patchSettings(patch)}
                settings={settings}
              />
              <form className="global-instructions-form" onSubmit={saveGlobalInstructions}>
                <span>
                  <strong>Global operating instructions</strong>
                  <small>
                    Applied to every coworker alongside its own operating instructions. Built-in
                    tool and approval safeguards still apply.
                  </small>
                </span>
                <textarea
                  aria-label="Global operating instructions"
                  disabled={working}
                  maxLength={50_000}
                  onChange={(event) => setGlobalInstructions(event.target.value)}
                  rows={7}
                  value={globalInstructions}
                />
                <div>
                  <small>
                    Use this for shared behavior, such as asking follow-up questions when required
                    information is missing.
                  </small>
                  <button
                    className="primary-button"
                    disabled={
                      working || globalInstructions.trim() === settings.globalOperatingInstructions
                    }
                  >
                    Save instructions
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === "models" ? (
            <section className="settings-section">
              <h2>Model Providers</h2>
              <div className="provider-grid model-provider-grid">
                {knownProviderCards.map((provider) => {
                  const connected = providerIsConnected(provider.id);
                  return (
                    <button
                      aria-pressed={modelProvider === provider.id}
                      className={`provider-card model-provider-card${
                        modelProvider === provider.id ? " selected" : ""
                      }`}
                      key={provider.id}
                      onClick={() => {
                        if (provider.id !== "openai") void cancelChatGPTSignIn();
                        setModelProvider(provider.id);
                        setNotice(null);
                      }}
                      type="button"
                    >
                      <span>
                        <strong>{provider.label}</strong>
                        <small>
                          {providerStatusLabel(provider.id)}
                          {settings.defaultModelProvider === provider.id ? " · Default" : ""}
                        </small>
                      </span>
                      <span
                        className={connected ? "connection-dot connected" : "connection-dot"}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
                {modelEndpoints.map((endpoint) => (
                  <button
                    aria-pressed={modelProvider === endpoint.id}
                    className={`provider-card model-provider-card${
                      modelProvider === endpoint.id ? " selected" : ""
                    }`}
                    key={endpoint.id}
                    onClick={() => {
                      void cancelChatGPTSignIn();
                      setModelProvider(endpoint.id);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{endpoint.name}</strong>
                      <small>
                        OpenAI-compatible
                        {settings.defaultModelProvider === endpoint.id ? " · Default" : ""}
                      </small>
                    </span>
                    <span aria-hidden="true" className="connection-dot connected" />
                  </button>
                ))}
                <button
                  aria-pressed={modelProvider === "add-endpoint"}
                  className={`provider-card model-provider-card add-endpoint-card${
                    modelProvider === "add-endpoint" ? " selected" : ""
                  }`}
                  onClick={() => {
                    void cancelChatGPTSignIn();
                    setModelProvider("add-endpoint");
                    setNotice(null);
                  }}
                  type="button"
                >
                  <span>
                    <strong>
                      <Icon name="plus" /> Add endpoint
                    </strong>
                    <small>Local or hosted OpenAI-compatible server</small>
                  </span>
                </button>
              </div>
              <form
                className="inline-credential-form model-credential-form"
                key={modelProvider}
                onSubmit={configureModel}
              >
                <div className="credential-form-heading">
                  <strong>
                    {addingEndpoint
                      ? "New OpenAI-compatible endpoint"
                      : modelProviderDisplayName(modelProvider, modelEndpoints)}
                  </strong>
                  <small>
                    {addingEndpoint ? (
                      "Name the endpoint so you can tell your local servers apart"
                    ) : modelProvider === "openai" &&
                      chatGPTBridgeAvailable &&
                      openAIAuthMode === "chatgpt-subscription" ? (
                      openAIPlanConnected ? (
                        <span className="credential-saved">
                          <Icon name="check" /> ChatGPT plan connected
                        </span>
                      ) : (
                        "Choose a ChatGPT account to connect"
                      )
                    ) : activeConnected ? (
                      <>
                        <span className="credential-saved">
                          <Icon name="check" />
                          {activeDefinition.apiKeyRequired ? "API key saved" : "Connected"}
                        </span>
                        {activeDefinition.apiKeyRequired
                          ? " · enter a new key to replace it"
                          : " · enter new settings to replace the saved ones"}
                      </>
                    ) : (
                      "Enter the provider credentials below"
                    )}
                  </small>
                </div>
                {modelProvider === "openai" && chatGPTBridgeAvailable ? (
                  <div aria-label="OpenAI sign-in method" className="chatgpt-auth-settings">
                    <fieldset
                      className="chatgpt-auth-choice"
                      disabled={working || chatGPTStatusLoading || chatGPTSignInPending}
                    >
                      <legend>Authentication method</legend>
                      {activeDefinition.authModes?.includes("api-key") ? (
                        <label>
                          <input
                            checked={openAIAuthMode === "api-key"}
                            name="openai-auth-mode"
                            onChange={() => void updateOpenAIAuthMode("api-key")}
                            type="radio"
                          />
                          <span>
                            <strong>OpenAI API key</strong>
                            <small>Use your OpenAI API account and billing.</small>
                          </span>
                        </label>
                      ) : null}
                      {activeDefinition.authModes?.includes("chatgpt-subscription") ? (
                        <label>
                          <input
                            checked={openAIAuthMode === "chatgpt-subscription"}
                            name="openai-auth-mode"
                            onChange={() => void updateOpenAIAuthMode("chatgpt-subscription")}
                            type="radio"
                          />
                          <span>
                            <strong>ChatGPT subscription</strong>
                            <small>Use your ChatGPT plan’s allowance for eligible requests.</small>
                          </span>
                        </label>
                      ) : null}
                    </fieldset>
                    {openAIAuthMode === "chatgpt-subscription" ? (
                      <div className="chatgpt-account-settings">
                        {chatGPTStatusLoading && !chatGPTStatus ? (
                          <p role="status">Checking ChatGPT connection…</p>
                        ) : null}
                        {!chatGPTStatusLoading && !chatGPTStatus && chatGPTError ? (
                          <button
                            className="text-button"
                            onClick={() => void refreshChatGPTStatus()}
                            type="button"
                          >
                            Try again
                          </button>
                        ) : null}
                        {chatGPTStatus &&
                        (openAISavedAccounts.length > 1 ||
                          (!chatGPTStatus.activeAccountId &&
                            openAISavedAccounts.some((account) => !account.connected))) ? (
                          <label className="chatgpt-account-select">
                            <span>ChatGPT account</span>
                            <select
                              aria-label="ChatGPT account"
                              disabled={working || chatGPTSignInPending}
                              onChange={(event) => void selectChatGPTAccount(event.target.value)}
                              value={chatGPTStatus.activeAccountId ?? ""}
                            >
                              <option value="">Choose an account</option>
                              {openAISavedAccounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {chatGPTAccountDisplayName(account)}
                                  {!account.connected ? " · Reconnect" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {chatGPTStatus?.state === "waiting" || chatGPTSignInPending ? (
                          <div className="chatgpt-signin-waiting" role="status">
                            <span>Waiting for ChatGPT sign-in…</span>
                            <button
                              className="ghost-button"
                              onClick={() => void cancelChatGPTSignIn()}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : openAIPlanConnected && openAIActiveAccount ? (
                          <p className="chatgpt-account-connected" role="status">
                            Connected as <strong>{chatGPTAccountDisplayName(openAIActiveAccount)}</strong>.
                            Coworker uses this ChatGPT plan’s allowance for eligible requests.
                            You can manage usage in ChatGPT settings.
                          </p>
                        ) : chatGPTStatus?.state === "connected" && openAIActiveAccount ? (
                          <p className="chatgpt-account-permission" role="alert">
                            This ChatGPT account can’t use its plan with Coworker. Choose another
                            account or try signing in again.
                          </p>
                        ) : chatGPTStatus?.state === "sign-in-required" ? (
                          <p className="chatgpt-account-permission" role="alert">
                            Sign in to {openAIActiveAccount
                              ? chatGPTAccountDisplayName(openAIActiveAccount)
                              : "ChatGPT"} again to use your plan here.
                          </p>
                        ) : null}
                        {!openAIActiveAccount && openAISavedAccounts.length === 1 &&
                        !openAISavedAccounts[0]?.connected ? (
                          <p className="chatgpt-account-permission" role="status">
                            Saved account <strong>{chatGPTAccountDisplayName(openAISavedAccounts[0]!)}</strong>{" "}
                            needs to reconnect. Continue with ChatGPT to use this saved account.
                          </p>
                        ) : null}
                        {chatGPTError ? <p className="chatgpt-account-error" role="alert">{chatGPTError}</p> : null}
                        {!openAIPlanConnected && canContinueChatGPTSignIn &&
                        chatGPTStatus?.state !== "waiting" && !chatGPTSignInPending ? (
                          <button
                            className="chatgpt-signin-button"
                            disabled={working || chatGPTStatusLoading}
                            onClick={() => void continueChatGPTSignIn()}
                            type="button"
                          >
                            <img alt="" aria-hidden="true" src={chatGPTSignInMark} />
                            Continue with ChatGPT
                          </button>
                        ) : null}
                        {chatGPTStatus?.accounts.length ? (
                          <button
                            className="text-button chatgpt-add-account"
                            disabled={working || chatGPTSignInPending}
                            onClick={() => void startChatGPTSignIn()}
                            type="button"
                          >
                            Add another ChatGPT account
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {isEndpointForm ? (
                  <input
                    aria-label="Endpoint name"
                    defaultValue={selectedEndpoint?.name ?? ""}
                    maxLength={80}
                    name="endpointName"
                    placeholder="e.g. LM Studio on this Mac"
                    required
                    type="text"
                  />
                ) : null}
                {activeDefinition.baseUrlMode !== "none" ? (
                  <input
                    aria-label={`${activeLabel} base URL`}
                    name="baseUrl"
                    type="url"
                    placeholder={
                      activeDefinition.defaultBaseUrl ?? "http://127.0.0.1:1234/v1"
                    }
                    defaultValue={selectedEndpoint?.baseUrl || activeDefinition.defaultBaseUrl}
                    required={isEndpointForm || activeDefinition.baseUrlMode === "required"}
                  />
                ) : null}
                {!(modelProvider === "openai" &&
                  chatGPTBridgeAvailable &&
                  openAIAuthMode === "chatgpt-subscription") ? (
                  <input
                    aria-label={`${activeLabel} API key`}
                    name="apiKey"
                    type="password"
                    placeholder={
                      activeConnected
                        ? "Stored — enter to replace"
                        : activeDefinition.apiKeyPlaceholder || "Optional API key"
                    }
                    required={
                      activeDefinition.apiKeyRequired && !activeConnected && !addingEndpoint
                    }
                  />
                ) : null}
                <div className="credential-default-model">
                  <label className="settings-row">
                    <span>
                      <strong>Use as the global default model</strong>
                      <small>
                        New coworkers start with this model. You can override it per coworker.
                      </small>
                    </span>
                    <span className="toggle">
                      <input
                        checked={makeDefaultModel}
                        disabled={working}
                        onChange={(event) => setMakeDefaultModel(event.target.checked)}
                        type="checkbox"
                      />
                      <span />
                    </span>
                  </label>
                  {makeDefaultModel ? (
                    activeProvider && activeConnected && credentialsLoaded ? (
                      <ModelSelector
                        disabled={working}
                        key={`${activeProvider}:${openAIAuthMode}:${chatGPTStatus?.activeAccountId ?? ""}`}
                        onChange={setDefaultModelChoice}
                        provider={activeProvider}
                        value={defaultModelChoice}
                      />
                    ) : (
                      <small className="credential-default-model-hint">
                        The model list loads once the connection is verified. Saving connects the
                        provider and makes its first available model the default; you can change
                        it here right after.
                      </small>
                    )
                  ) : null}
                </div>
                <div className="credential-form-actions">
                  {!(modelProvider === "openai" &&
                    chatGPTBridgeAvailable &&
                    openAIAuthMode === "chatgpt-subscription" &&
                    !openAIPlanConnected) ? (
                    <button className="primary-button" disabled={working}>
                      {modelProvider === "openai" && openAIAuthMode === "chatgpt-subscription"
                        ? "Save settings"
                        : "Verify and save"}
                    </button>
                  ) : null}
                  {selectedEndpoint ? (
                    <button
                      className="ghost-button danger"
                      disabled={working}
                      onClick={() => confirmRemoveEndpoint(selectedEndpoint)}
                      type="button"
                    >
                      Remove endpoint
                    </button>
                  ) : activeProvider && activeConfigured ? (
                    <button
                      className="ghost-button danger"
                      disabled={working}
                      onClick={() => confirmDisconnectModel(activeProvider)}
                      type="button"
                    >
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
              <small className="settings-model-default-note">
                {settings.defaultModelProvider && settings.defaultModelName
                  ? `Current global default: ${modelProviderDisplayName(settings.defaultModelProvider, modelEndpoints)} · ${settings.defaultModelName}`
                  : "No global default model configured yet. Connect a provider with the switch on to set one."}
              </small>
            </section>
          ) : null}

          {tab === "skills" ? (
            <section className="settings-section skills-settings">
              <span className="eyebrow">Agent Skills standard</span>
              <h2>Global skills, configured per coworker</h2>
              <p>
                Install a compliant skill.md directly, or upload a standard .skill/.zip package
                containing one root folder whose name matches the skill. Packaged resources are
                preserved; each coworker can opt in independently.
              </p>
              <form className="skill-url-form" onSubmit={installSkill}>
                <input
                  aria-label="Agent Skill URL"
                  name="url"
                  placeholder="https://example.com/my-skill/SKILL.md"
                  required
                  type="url"
                />
                <button className="primary-button" disabled={working}>Install skill</button>
              </form>
              <label className="skill-upload-button">
                <input
                  accept=".md,.skill,.zip,text/markdown,application/zip"
                  disabled={working}
                  onChange={(event) => {
                    void uploadSkill(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  type="file"
                />
                <span>Upload skill.md, .skill, or .zip</span>
              </label>

              <div className="skill-settings-list">
                {skills.map((skill) => (
                  <article className="skill-settings-card" key={skill.id}>
                    <header>
                      <span>
                        <strong>{skill.name}</strong>
                        <small>{skill.bundled ? "Bundled" : skill.sourceUrl ?? "Installed"}</small>
                      </span>
                      {!skill.bundled ? (
                        <button
                          className="ghost-button danger"
                          disabled={working}
                          onClick={() => confirmRemoveSkill(skill)}
                          type="button"
                        >
                          Remove
                        </button>
                      ) : null}
                    </header>
                    <p>{skill.description}</p>
                    <div className="skill-coworker-toggles">
                      {coworkers.map((coworker) => (
                        <label key={coworker.id}>
                          <input
                            checked={coworker.enabledSkillIds.includes(skill.id)}
                            disabled={working}
                            onChange={(event) =>
                              void toggleCoworkerSkill(coworker, skill, event.target.checked)
                            }
                            type="checkbox"
                          />
                          <span>{coworker.name}</span>
                        </label>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {tab === "web-search" ? (
            <section className="settings-section">
              <span className="eyebrow">Web search</span>
              <h2>Search providers</h2>
              <p>
                Web search works without a key on Firecrawl's free tier, which has a daily limit. Add
                an API key for higher limits; the first configured provider is used.
              </p>
              <div className="provider-grid model-provider-grid">
                {webSearchProviders.map((provider) => (
                  <button
                    aria-pressed={webSearchProvider === provider}
                    className={`provider-card model-provider-card${
                      webSearchProvider === provider ? " selected" : ""
                    }`}
                    key={provider}
                    onClick={() => {
                      setWebSearchProvider(provider);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{providerLabel(provider)}</strong>
                      <small>
                        {credentialStatus[`web-search:${provider}`] ? "Connected" : "Not connected"}
                      </small>
                    </span>
                    <span
                      aria-hidden="true"
                      className={
                        credentialStatus[`web-search:${provider}`]
                          ? "connection-dot connected"
                          : "connection-dot"
                      }
                    />
                  </button>
                ))}
              </div>
              <form
                className="inline-credential-form model-credential-form"
                key={webSearchProvider}
                onSubmit={configureWebSearch}
              >
                <div className="credential-form-heading">
                  <strong>{providerLabel(webSearchProvider)}</strong>
                  <small>
                    {credentialStatus[`web-search:${webSearchProvider}`] ? (
                      <>
                        <span className="credential-saved">
                          <Icon name="check" />
                          API key saved
                        </span>
                        {" · enter a new key to replace it"}
                      </>
                    ) : (
                      "Enter the provider API key below"
                    )}
                  </small>
                </div>
                <input
                  aria-label={`${providerLabel(webSearchProvider)} API key`}
                  name="apiKey"
                  placeholder={
                    credentialStatus[`web-search:${webSearchProvider}`]
                      ? "Stored — enter to replace"
                      : `${providerLabel(webSearchProvider)} API key`
                  }
                  required
                  type="password"
                />
                <div className="credential-form-actions">
                  <button className="primary-button" disabled={working}>Save search key</button>
                  {credentialStatus[`web-search:${webSearchProvider}`] ? (
                    <button
                      className="ghost-button danger"
                      disabled={working}
                      onClick={() => confirmRemoveSearchKey(webSearchProvider)}
                      type="button"
                    >
                      Remove key
                    </button>
                  ) : null}
                </div>
              </form>
            </section>
          ) : null}

          {tab === "integrations" ? (
            <section className="settings-section">
              <h2>Email delivery</h2>
              <p>
                Local outbox writes an auditable .eml file. Resend performs a real send only after
                approval.
              </p>
              <form className="form-stack integration-form" onSubmit={configureEmail}>
                <label>
                  <span>Delivery mode</span>
                  <select
                    name="mode"
                    defaultValue={integrations.find((item) => item.type === "email")?.mode ?? "local-outbox"}
                  >
                    <option value="local-outbox">Local outbox (safe demo)</option>
                    <option value="resend">Resend API</option>
                  </select>
                </label>
                <label>
                  <span>From address</span>
                  <input
                    name="fromAddress"
                    type="email"
                    defaultValue={String(
                      integrations.find((item) => item.type === "email")?.config.fromAddress ??
                        "coworker@localhost",
                    )}
                  />
                </label>
                <label>
                  <span>Resend API key</span>
                  <input
                    name="apiKey"
                    type="password"
                    placeholder={
                      credentialStatus["integration:email:resend"]
                        ? "Stored — enter a value to replace"
                        : "Required only for Resend"
                    }
                  />
                </label>
                <div>
                  <button className="primary-button" disabled={working}>
                    Save email integration
                  </button>
                </div>
              </form>

              <MessagingConnections
                coworkers={coworkers}
                telegram={telegramStatuses}
                discord={discordStatuses}
                working={working}
                onTelegramConfigure={(input) => runMessagingAction(() => saveTelegramConnection(input))}
                onDiscordConfigure={(input) => runMessagingAction(() => saveDiscordConnection(input))}
                onTelegramUnpair={(id) => runMessagingAction(() => window.coworker.integrations.unpairTelegram(id))}
                onTelegramDisconnect={(id) => runMessagingAction(() => window.coworker.integrations.disconnectTelegram(id))}
                onDiscordUnpair={(id) => runMessagingAction(() => window.coworker.integrations.unpairDiscord(id))}
                onDiscordDisconnect={(id) => runMessagingAction(() => window.coworker.integrations.disconnectDiscord(id))}
              />

            </section>
          ) : null}

          {tab === "archived" ? (
            <section className="settings-section">
              <span className="eyebrow">Archived conversations</span>
              <h2>Restore or permanently delete</h2>
              <p>
                Archived conversations are hidden everywhere else. Restoring brings one back to
                its coworker; deleting removes it and its full history forever. A conversation
                also restores itself if a new message arrives in it.
              </p>
              {conversations.filter((conversation) => conversation.archivedAt).length === 0 ? (
                <p className="telegram-hint">
                  Nothing is archived. Hover a conversation in a coworker's History menu to
                  archive it.
                </p>
              ) : (
                conversations
                  .filter((conversation) => conversation.archivedAt)
                  .sort((left, right) =>
                    (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
                  )
                  .map((conversation) => {
                    const members = conversation.memberIds
                      .map(
                        (memberId) =>
                          coworkers.find((candidate) => candidate.id === memberId)?.name,
                      )
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <div className="telegram-connection" key={conversation.id}>
                        <div className="telegram-connection-identity">
                          <strong>{conversation.title}</strong>
                          <small>
                            {conversation.kind === "group" ? "Channel" : "Conversation"}
                            {members ? ` with ${members}` : ""} · archived{" "}
                            {formatClockDateTime(conversation.archivedAt!)}
                          </small>
                        </div>
                        <div className="telegram-connection-actions">
                          <button
                            className="secondary-button"
                            disabled={working}
                            onClick={() => void restoreArchivedConversation(conversation)}
                            type="button"
                          >
                            Restore
                          </button>
                          <button
                            className="secondary-button danger"
                            disabled={working}
                            onClick={() => void deleteArchivedConversation(conversation)}
                            type="button"
                          >
                            {confirmingArchivedDelete === conversation.id
                              ? "Confirm delete"
                              : "Delete forever"}
                          </button>
                        </div>
                      </div>
                    );
                  })
              )}
            </section>
          ) : null}

          {tab === "data" ? (
            <section className="settings-section">
              <span className="eyebrow">Local data</span>
              <h2>Your workspace lives here</h2>
              <p>
                Coworker version <strong>{version}</strong>
              </p>
              <p>SQLite, artifacts, encrypted credential blobs, logs, and the local email outbox.</p>
              <p>
                Provider failures are recorded in <code>logs/provider-errors.jsonl</code>. API keys
                and prompt contents are excluded and secret-like values are redacted.
              </p>
              <div className="data-path">
                <Icon name="file" />
                <code>{dataPath}</code>
              </div>
              <div className="data-actions">
                <button className="secondary-button" onClick={() => void window.coworker.app.openDataFolder()}>
                  Open data folder
                </button>
                <button
                  className="primary-button"
                  onClick={() =>
                    void window.coworker.app.backup().then((path) => {
                      if (path) {
                        setNoticeKind("success");
                        setNotice(`Database backup saved to ${path}`);
                      }
                    })
                  }
                >
                  Back up database
                </button>
                <button
                  className="primary-button"
                  onClick={() => void exportDataBackup()}
                  type="button"
                >
                  <Icon name="download" /> Export all data
                </button>
              </div>

              <div className="provider-diagnostics">
                <header>
                  <span>
                    <span className="eyebrow">Diagnostics</span>
                    <h3>Diagnostics and support</h3>
                    <small>
                      Download redacted application and provider logs to send with a support request.
                    </small>
                  </span>
                  <div>
                    <button
                      className="secondary-button"
                      disabled={diagnosticsLoading}
                      onClick={() => void refreshProviderErrors()}
                      type="button"
                    >
                      Refresh
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyProviderReport()}
                      type="button"
                    >
                      Copy report
                    </button>
                    <button
                      className="primary-button"
                      onClick={() => void exportSupportBundle()}
                      type="button"
                    >
                      <Icon name="download" /> Download diagnostics ZIP
                    </button>
                  </div>
                </header>
                <p className="diagnostics-privacy-note">
                  Credentials and account names are redacted where recognized. Review the ZIP
                  before sending it because technical logs can contain file names and error context.
                </p>

                {diagnosticsLoading ? (
                  <div className="provider-diagnostics-empty">Loading provider logs…</div>
                ) : providerErrors.length === 0 ? (
                  <div className="provider-diagnostics-empty">
                    <Icon name="check" /> No provider errors have been recorded.
                  </div>
                ) : (
                  <div className="provider-diagnostics-list">
                    {providerErrors.map((error, index) => (
                      <article key={`${error.timestamp}:${error.runId ?? error.taskId ?? index}`}>
                        <header>
                          <span>
                            <strong>{error.provider}</strong>
                            {error.model ? <code>{error.model}</code> : null}
                            <b>{error.phase.replaceAll("_", " ")}</b>
                            {error.status ? <b>HTTP {error.status}</b> : null}
                          </span>
                          <time dateTime={error.timestamp}>{formatDiagnosticTime(error.timestamp)}</time>
                        </header>
                        <p>{error.message}</p>
                        <details>
                          <summary>Technical details</summary>
                          <pre>{JSON.stringify(error, null, 2)}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      {chatGPTBridgeAvailable ? (
        <ChatGPTWelcomeDialog
          onAcknowledge={acknowledgeChatGPTWelcome}
          status={chatGPTStatus}
        />
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          busyLabel={confirmation.busyLabel}
          confirmLabel={confirmation.confirmLabel}
          eyebrow={confirmation.eyebrow}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmation.onConfirm}
          title={confirmation.title}
        >
          {confirmation.body}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function credentialLocation(key: string): { label: string; tab: SettingsTab } {
  const webSearch = webSearchProviders.find((provider) => key === `web-search:${provider}`);
  if (webSearch) return { label: `${providerLabel(webSearch)} web search key`, tab: "web-search" };
  if (key === "integration:email:resend") return { label: "Resend email key", tab: "integrations" };
  const model = remoteModelProviderDefinitions.find(
    (provider) =>
      key === modelProviderCredentialKey(provider.id) ||
      key === modelProviderBaseUrlKey(provider.id),
  );
  if (model) {
    return {
      label: key.endsWith(":base-url")
        ? `${model.label} base URL`
        : `${model.label} API key`,
      tab: "models",
    };
  }
  return { label: key, tab: "models" };
}

function providerLabel(provider: WebSearchProvider): string {
  return provider === "serpapi"
    ? "SerpAPI"
    : `${provider[0]?.toUpperCase()}${provider.slice(1)}`;
}

function formatDiagnosticTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatClockTime(date, { day: "numeric", month: "short", year: "numeric", second: "2-digit" });
}
