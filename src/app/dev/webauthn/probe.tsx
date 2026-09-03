"use client";

import { useEffect, useState } from "react";

type Check = { label: string; value: string; ok: boolean | null };

/**
 * Raw WebAuthn API, no library. @simplewebauthn would be the right dependency for the real
 * feature, but a capability probe must not depend on a library's own browser support
 * matrix -- the question is what THIS browser does, not what a wrapper does.
 */
export function WebauthnProbe() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [ceremony, setCeremony] = useState<{ ok: boolean; detail: string } | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    async function probe() {
      const results: Check[] = [];

      const secure = window.isSecureContext;
      results.push({ label: "Contexto seguro (HTTPS)", value: secure ? "sim" : "não", ok: secure });

      const hasApi = typeof window.PublicKeyCredential !== "undefined";
      results.push({ label: "API PublicKeyCredential", value: hasApi ? "existe" : "ausente", ok: hasApi });

      if (hasApi) {
        try {
          const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          results.push({
            label: "Autenticador do aparelho (Face ID / digital)",
            value: platform ? "disponível" : "indisponível",
            ok: platform,
          });
        } catch (error) {
          results.push({ label: "Autenticador do aparelho", value: `erro: ${String(error)}`, ok: false });
        }

        // Not required for this flow, but its absence is a good signal that the embedded
        // browser only implements part of the spec.
        try {
          const conditional = await PublicKeyCredential.isConditionalMediationAvailable?.();
          results.push({
            label: "Mediação condicional",
            value: conditional === undefined ? "não implementada" : conditional ? "sim" : "não",
            ok: null,
          });
        } catch {
          results.push({ label: "Mediação condicional", value: "erro", ok: null });
        }
      }

      results.push({ label: "Origem", value: window.location.origin, ok: null });
      results.push({ label: "Navegador", value: navigator.userAgent, ok: null });

      setChecks(results);
    }
    void probe();
  }, []);

  /**
   * The capability flags above can all say "yes" and the ceremony still fail -- an embedded
   * browser can expose the API and then refuse the actual prompt. Only really invoking it
   * proves it works, so this runs a full registration and reports what came back.
   *
   * This DOES create a real passkey on the phone (named "Selo (teste)"). Nothing is sent
   * anywhere -- the credential is discarded the moment this function returns -- but it can
   * be deleted afterwards in the phone's password settings.
   */
  async function runCeremony() {
    setRunning(true);
    setCeremony(null);
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "Selo (teste)", id: window.location.hostname },
          user: { id: userId, name: "teste@selo", displayName: "Teste" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 }, // ES256
            { type: "public-key", alg: -257 }, // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform", // the phone itself, never a USB key
            userVerification: "required", // must actually ask for the finger/face
            residentKey: "preferred",
          },
          timeout: 60_000,
          attestation: "none",
        },
      });

      if (!credential) {
        setCeremony({ ok: false, detail: "O navegador devolveu credencial nula." });
      } else {
        setCeremony({
          ok: true,
          detail: `Funcionou. Tipo: ${credential.type}. Pode apagar a chave "Selo (teste)" nas definições do telemóvel.`,
        });
      }
    } catch (error) {
      const err = error as { name?: string; message?: string };
      setCeremony({
        ok: false,
        detail: `${err.name ?? "Erro"}: ${err.message ?? String(error)}`,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-3xl bg-card p-5">
        <h2 className="font-heading text-lg font-extrabold tracking-tight">1. O que o navegador diz</h2>
        {checks === null ? (
          <p className="mt-3 text-sm text-muted-foreground">A verificar…</p>
        ) : (
          <dl className="mt-3.5 flex flex-col gap-2.5 text-[13px]">
            {checks.map((check) => (
              <div key={check.label} className="flex flex-col gap-0.5 border-b border-border/45 pb-2.5 last:border-0">
                <dt className="font-bold">
                  {check.ok === null ? "•" : check.ok ? "✓" : "✗"} {check.label}
                </dt>
                <dd
                  className={`text-[12px] break-all ${
                    check.ok === false ? "font-bold text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {check.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="rounded-3xl bg-card p-5">
        <h2 className="font-heading text-lg font-extrabold tracking-tight">2. O teste que conta</h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Os sinais acima podem dizer todos “sim” e o pedido falhar na mesma. Toque no botão: deve
          aparecer o pedido de digital ou de rosto do telemóvel.
        </p>
        <button
          type="button"
          onClick={runCeremony}
          disabled={running}
          className="mt-4 w-full cursor-pointer rounded-full bg-primary px-5 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-60"
        >
          {running ? "A pedir…" : "Pedir digital / Face ID"}
        </button>

        {ceremony ? (
          <p
            className={`mt-3.5 rounded-2xl px-4 py-3 text-[13px] break-words ${
              ceremony.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"
            }`}
          >
            {ceremony.detail}
          </p>
        ) : null}
      </section>

      <p className="text-[12px] text-muted-foreground">
        Nada nesta página é guardado ou enviado. Apague esta rota depois do teste.
      </p>
    </div>
  );
}
