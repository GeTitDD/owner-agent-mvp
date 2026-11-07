import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

const TOKEN_KEY = "owner-agent:approval-token";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const cell = (content: string | HTMLElement): HTMLTableCellElement => {
  const td = el("td");
  if (typeof content === "string") {
    td.textContent = content;
    td.title = content;
  } else {
    td.append(content);
  }
  return td;
};

const table = (headers: string[], rows: Array<Array<string | HTMLElement>>): HTMLTableElement => {
  const node = el("table", "owner-table");
  const head = el("thead");
  const headRow = el("tr");
  for (const header of headers) headRow.append(el("th", undefined, header));
  head.append(headRow);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const value of row) tr.append(cell(value));
    body.append(tr);
  }
  node.append(head, body);
  return node;
};

const mono = (value: string): HTMLElement => {
  const code = el("code", "owner-mono", value);
  code.title = value;
  return code;
};

const statusTone = (status: string): string => {
  if (["applied", "tested_pass", "succeeded", "completed"].includes(status)) return "ok";
  if (["failed", "rejected", "tested_fail", "cancelled"].includes(status)) return "bad";
  if (["pending_approval", "proposed", "queued", "running"].includes(status)) return "warn";
  return "neutral";
};

const statusChip = (status: string, tone?: string): HTMLElement =>
  el("span", `owner-status owner-status--${tone ?? statusTone(status)}`, status);

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({
      id: "owner-agent",
      label: "Owner",
      page: { id: "owner-agent" },
      icon: "fileText"
    });

    host.ui.registerPage({
      id: "owner-agent",
      label: "Owner Agent",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);

        const root = el("div", "owner-page");
        const header = el("div", "owner-header");
        const heading = el("h1", undefined, "Owner Agent");
        const refresh = el("button", "owner-button", "Refresh");
        header.append(heading, refresh);

        // ---- 审批令牌：只存在于当前浏览器标签，不经过 Gateway ----
        const tokenBar = el("div", "owner-token-bar");
        const tokenLabel = el("label", "owner-token-label", "Approval token");
        const tokenInput = el("input", "owner-input");
        tokenInput.type = "password";
        tokenInput.autocomplete = "off";
        tokenInput.placeholder = "paste the contents of approval.token";
        tokenInput.setAttribute("aria-label", "Approval token");
        const tokenSave = el("button", "owner-button", "Save");
        const tokenClear = el("button", "owner-button", "Clear");
        const tokenState = el("span", "owner-token-state");
        tokenBar.append(tokenLabel, tokenInput, tokenSave, tokenClear, tokenState);

        const note = el(
          "p",
          "owner-muted",
          "Approvals are executed by your browser directly against the Owner sidecar with a separate approval token. The model and the plugin backend never receive it."
        );
        const notice = el("p", "owner-notice");
        const error = el("p", "owner-error");
        const status = el("div", "owner-cards");
        const sections = el("div", "owner-sections");
        const dialog = el("dialog", "owner-dialog");
        root.append(header, tokenBar, note, notice, error, status, sections, dialog);
        container.append(root);

        let disposed = false;
        let loading = false;
        let sidecar = {
          baseUrl: "http://127.0.0.1:47830",
          approvalRequired: true,
          connected: true,
          error: ""
        };
        let approvalToken = window.sessionStorage.getItem(TOKEN_KEY) ?? "";

        const updateTokenState = (): void => {
          tokenState.textContent = approvalToken ? "set for this tab" : "not set";
          tokenState.classList.toggle("owner-token-set", Boolean(approvalToken));
        };
        updateTokenState();

        tokenSave.onclick = () => {
          approvalToken = tokenInput.value.trim();
          if (approvalToken) window.sessionStorage.setItem(TOKEN_KEY, approvalToken);
          else window.sessionStorage.removeItem(TOKEN_KEY);
          tokenInput.value = "";
          updateTokenState();
        };
        tokenClear.onclick = () => {
          approvalToken = "";
          window.sessionStorage.removeItem(TOKEN_KEY);
          tokenInput.value = "";
          updateTokenState();
        };

        const friendly = (cause: unknown): string => {
          const message = String((cause as Error)?.message ?? cause);
          if (/sidecar token is missing/i.test(message)) {
            return "Owner sidecar token is missing. Set OWNER_AGENT_SIDECAR_TOKEN_FILE or place sidecar.token in ~/.domain-context.";
          }
          if (/ECONNREFUSED|fetch failed|failed to fetch/i.test(message)) {
            return `Cannot reach the Owner sidecar at ${sidecar.baseUrl}. Start it with: node bin/ownerctl.mjs serve`;
          }
          if (/plugin session action failed/i.test(message)) {
            return "The Owner plugin could not reach its sidecar. Check the sidecar URL and token, then retry.";
          }
          return message;
        };

        const report = (cause: unknown): void => {
          if (!disposed) error.textContent = friendly(cause);
        };

        /** 决策请求：只带审批令牌，不经过 Gateway 或插件后端。 */
        const decision = async (path: string, payload: unknown): Promise<any> => {
          if (!approvalToken) throw new Error("Enter the approval token first.");
          const response = await fetch(`${sidecar.baseUrl}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-owner-approval-token": approvalToken,
              "x-owner-origin": JSON.stringify({
                gatewayInstanceId: "control-ui",
                operatorId: "owner",
                pluginVersion: "0.2.0"
              })
            },
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            if (response.status === 403) {
              throw new Error("Approval token was rejected. Paste the current approval.token and try again.");
            }
            throw new Error(data?.error ?? `HTTP ${response.status}`);
          }
          return data;
        };

        /**
         * 审批前必须展示冻结内容，并要求显式勾选。
         * 勾选前确认按钮不可用，避免“点一下就 apply”。
         */
        const openReview = ({
          title,
          rows,
          diff,
          confirmLabel,
          success,
          readOnly = false,
          onConfirm
        }: {
          title: string;
          rows: Array<[string, string | HTMLElement]>;
          diff?: string;
          confirmLabel?: string;
          success?: string;
          readOnly?: boolean;
          onConfirm?: () => Promise<unknown>;
        }): void => {
          const panel = el("div", "owner-review");
          panel.append(el("h2", undefined, title));
          const list = el("dl", "owner-review-list");
          for (const [label, value] of rows) {
            list.append(el("dt", undefined, label));
            const dd = el("dd");
            dd.append(typeof value === "string" ? mono(value) : value);
            list.append(dd);
          }
          panel.append(list);

          if (diff) {
            panel.append(el("h3", undefined, "Frozen diff"));
            panel.append(el("pre", "owner-diff", diff));
          }

          const reviewError = el("p", "owner-error");
          const actions = el("div", "owner-review-actions");

          if (readOnly) {
            const close = el("button", "owner-button", "Close");
            close.onclick = () => dialog.close();
            actions.append(close);
            panel.append(reviewError, actions);
          } else {
            const confirmRow = el("label", "owner-confirm");
            const checkbox = el("input");
            checkbox.type = "checkbox";
            confirmRow.append(checkbox, el("span", undefined,
              "I reviewed the IDs, hashes and content above."));

            const cancel = el("button", "owner-button", "Cancel");
            const confirm = el("button", "owner-button owner-button-danger", confirmLabel ?? "Confirm");
            confirm.disabled = true;
            actions.append(cancel, confirm);
            panel.append(reviewError, confirmRow, actions);

            checkbox.onchange = () => { confirm.disabled = !checkbox.checked || !approvalToken; };
            if (!approvalToken) {
              panel.append(el("p", "owner-warning",
                "Approval token is not set for this tab; decisions are disabled."));
            }

            cancel.onclick = () => dialog.close();
            confirm.onclick = async () => {
              confirm.disabled = true;
              cancel.disabled = true;
              confirm.textContent = "Working…";
              reviewError.textContent = "";
              try {
                await onConfirm?.();
                dialog.close();
                await load();
                notice.textContent = success ?? "";
              } catch (cause) {
                reviewError.textContent = friendly(cause);
                confirm.textContent = confirmLabel ?? "Confirm";
                cancel.disabled = false;
                if (!disposed) confirm.disabled = !checkbox.checked;
              }
            };
          }

          dialog.replaceChildren(panel);
          if (!dialog.open) dialog.showModal();
        };

        const actionButton = (label: string, run: () => void): HTMLButtonElement => {
          const button = el("button", "owner-button", label);
          button.onclick = run;
          return button;
        };

        const renderStatus = (summary: {
          projectCount: number;
          totalJobs: number;
          pendingJobApprovals: number;
          pendingPatchApprovals: number;
          pendingRepairApprovals: number;
          pendingSandboxApprovals: number;
        }): void => {
          status.replaceChildren(
            ...([
              ["Projects", summary.projectCount, false],
              ["Jobs", summary.totalJobs, false],
              ["Pending job approvals", summary.pendingJobApprovals, true],
              ["Pending patch approvals", summary.pendingPatchApprovals, true],
              ["Pending repair approvals", summary.pendingRepairApprovals, true],
              ["Pending sandbox approvals", summary.pendingSandboxApprovals, true]
            ] as Array<[string, number, boolean]>).map(([label, value, pending]) => {
              const card = el("div",
                `owner-card${pending && value > 0 ? " owner-card--attention" : ""}`);
              card.append(
                el("span", "owner-card-value", String(value)),
                el("span", "owner-card-label", label)
              );
              return card;
            })
          );
        };

        const section = (title: string, body: HTMLElement): HTMLElement => {
          const wrapper = el("section", "owner-section");
          wrapper.append(el("h2", undefined, title), body);
          return wrapper;
        };

        const empty = (text: string): HTMLElement => el("p", "owner-muted", text);

        const connectionPanel = (): HTMLElement => {
          const panel = el("div", "owner-connect");
          panel.append(el("h2", undefined, "Owner sidecar is not connected"));
          panel.append(el("p", "owner-muted",
            `Target: ${sidecar.baseUrl}. Start it with "node bin/ownerctl.mjs serve".`));
          if (sidecar.error) panel.append(el("pre", "owner-detail", sidecar.error));
          panel.append(actionButton("Retry", () => { void load(); }));
          return panel;
        };

        const reviewJob = (job: any): void => openReview({
          title: `Approve job ${job.id.slice(0, 8)}`,
          rows: [
            ["Job id", job.id],
            ["Project", job.projectId],
            ["Type", job.jobType],
            ["Title", job.title],
            ["Status", job.status]
          ],
          confirmLabel: "Approve job",
          success: `Job ${job.id.slice(0, 8)} approved.`,
          onConfirm: () => decision(`/owner/v1/jobs/${encodeURIComponent(job.id)}/approve`, {})
        });

        const reviewPatch = async (patch: any): Promise<void> => {
          const detail = await feature.invoke("patch.detail", { proposalId: patch.id });
          const applying = detail.status === "approved";
          openReview({
            title: applying ? `Apply patch ${detail.id.slice(0, 8)}` : `Approve patch ${detail.id.slice(0, 8)}`,
            rows: [
              ["Proposal id", detail.id],
              ["Status", detail.status],
              ["Project", detail.projectId],
              ["Base", detail.baseSha],
              ["Proposal hash", detail.proposalHash],
              ["Approved hash", detail.approvedHash || "(not approved)"],
              ["Paths", detail.paths.join(", ") || "-"]
            ],
            diff: detail.diff || "(no diff recorded)",
            confirmLabel: applying ? "Apply approved patch" : "Approve patch (no apply)",
            success: applying
              ? `Patch ${detail.id.slice(0, 8)} applied.`
              : `Patch ${detail.id.slice(0, 8)} approved. Review it again to apply.`,
            onConfirm: () => decision(
              `/owner/v1/patches/${encodeURIComponent(detail.id)}/${applying ? "apply" : "approve"}`,
              { hash: detail.proposalHash }
            )
          });
        };

        const viewPatch = async (patch: any): Promise<void> => {
          const detail = await feature.invoke("patch.detail", { proposalId: patch.id });
          openReview({
            title: `Patch ${detail.id.slice(0, 8)}`,
            rows: [
              ["Proposal id", detail.id],
              ["Status", detail.status],
              ["Project", detail.projectId],
              ["Base", detail.baseSha],
              ["Proposal hash", detail.proposalHash],
              ["Approved hash", detail.approvedHash || "(not approved)"],
              ["Paths", detail.paths.join(", ") || "-"]
            ],
            diff: detail.diff || "(no diff recorded)",
            readOnly: true
          });
        };

        const reviewSandbox = async (run: any): Promise<void> => {
          const detail = await feature.invoke("sandbox.detail", { runId: run.id });
          openReview({
            title: `Approve sandbox ${detail.id.slice(0, 8)}`,
            rows: [
              ["Run id", detail.id],
              ["Status", detail.status],
              ["Project", detail.projectId],
              ["Proposal", detail.proposalId],
              ["Profile", detail.profileId],
              ["Image digest", detail.imageDigest],
              ["Profile hash", detail.profileHash],
              ["Test plan hash", detail.testPlanHash],
              ["Snapshot hash", detail.snapshotHash],
              ["Approval hash", detail.approvalHash],
              ["Include paths", detail.includePaths.join(", ") || "(none)"]
            ],
            confirmLabel: "Approve sandbox",
            success: `Sandbox ${detail.id.slice(0, 8)} approved.`,
            onConfirm: () => decision(
              `/owner/v1/sandbox-runs/${encodeURIComponent(detail.id)}/approve`,
              { hash: detail.approvalHash }
            )
          });
        };

        const reviewRepair = async (cycle: any): Promise<void> => {
          const detail = await feature.invoke("repair.detail", { cycleId: cycle.id });
          openReview({
            title: `Approve repair ${detail.id.slice(0, 8)}`,
            rows: [
              ["Cycle id", detail.id],
              ["Status", detail.status],
              ["Project", detail.projectId],
              ["Source run", detail.sourceSandboxRunId],
              ["Source base", detail.sourceBaseSha],
              ["Repair scope", detail.repairScope.join(", ") || "-"],
              ["Context hash", detail.contextHash],
              ["Approval hash", detail.approvalHash],
              ["Iteration", `${detail.iteration}/${detail.maxIterations}`]
            ],
            confirmLabel: "Approve repair",
            success: `Repair ${detail.id.slice(0, 8)} approved.`,
            onConfirm: () => decision(
              `/owner/v1/repair-cycles/${encodeURIComponent(detail.id)}/approve`,
              { hash: detail.approvalHash }
            )
          });
        };

        const createSandbox = (patch: any): void => {
          if (!window.confirm(
            `Create a pending sandbox run for proposal ${patch.id.slice(0, 8)}?\n`
            + `hash: ${patch.proposalHash}\nIt still needs a separate hash-bound approval.`
          )) return;
          error.textContent = "";
          void feature.invoke("sandbox.submit", { proposalId: patch.id })
            .then(async () => {
              await load();
              notice.textContent = "Sandbox run created; review it below.";
            })
            .catch(report);
        };

        const load = async (): Promise<void> => {
          if (loading || disposed) return;
          loading = true;
          refresh.disabled = true;
          error.textContent = "";
          sections.replaceChildren(empty("Loading Owner data…"));
          try {
            const info = await feature.invoke("sidecar.info", {});
            if (disposed) return;
            sidecar = info;
            if (!info.connected) {
              status.replaceChildren();
              sections.replaceChildren(connectionPanel());
              return;
            }

            const [summary, jobs, patches, repairs, sandboxes] = await Promise.all([
              feature.invoke("status", {}),
              feature.invoke("jobs.list", { limit: 20 }),
              feature.invoke("patch.list", { limit: 20 }),
              feature.invoke("repair.list", { limit: 20 }),
              feature.invoke("sandbox.list", { limit: 20 })
            ]);
            if (disposed) return;
            renderStatus(summary);
            const sandboxByProposal = new Set(sandboxes.items.map((run) => run.proposalId));
            const patchActions = (patch: any): HTMLElement => {
              const wrap = el("span", "owner-row-actions");
              if (patch.status === "proposed") {
                wrap.append(actionButton("Review", () => { void reviewPatch(patch).catch(report); }));
              } else if (patch.status === "approved") {
                wrap.append(actionButton("Review & apply", () => { void reviewPatch(patch).catch(report); }));
                wrap.append(actionButton("View diff", () => { void viewPatch(patch).catch(report); }));
              } else {
                wrap.append(actionButton("View diff", () => { void viewPatch(patch).catch(report); }));
                if (patch.status === "applied" && !sandboxByProposal.has(patch.id)) {
                  wrap.append(actionButton("Create sandbox run", () => createSandbox(patch)));
                }
              }
              return wrap;
            };

            sections.replaceChildren(
              section(
                "Jobs",
                jobs.items.length === 0
                  ? empty("No jobs yet.")
                  : table(
                    ["Title", "Type", "Status", ""],
                    jobs.items.map((job) => [
                      job.title,
                      job.jobType,
                      statusChip(job.status),
                      job.status === "pending_approval"
                        ? actionButton("Review", () => reviewJob(job))
                        : ""
                    ])
                  )
              ),
              section(
                "Patch proposals",
                patches.items.length === 0
                  ? empty("No patch proposals.")
                  : table(
                    ["Proposal", "Status", "Paths", ""],
                    patches.items.map((patch) => [
                      patch.id.slice(0, 8),
                      statusChip(patch.status),
                      patch.paths.join(", ") || "-",
                      patchActions(patch)
                    ])
                  )
              ),
              section(
                "Sandbox runs",
                sandboxes.items.length === 0
                  ? empty("No sandbox runs.")
                  : table(
                    ["Run", "Status", "Execution", "Tests", ""],
                    sandboxes.items.map((run) => [
                      run.id.slice(0, 8),
                      statusChip(
                        run.status,
                        run.testStatus === "fail" ? "bad" : run.testStatus === "pass" ? "ok" : undefined
                      ),
                      run.executionStatus || "-",
                      run.testStatus || "-",
                      run.status === "pending_approval"
                        ? actionButton("Review", () => { void reviewSandbox(run).catch(report); })
                        : ""
                    ])
                  )
              ),
              section(
                "Repair cycles",
                repairs.items.length === 0
                  ? empty("No repair cycles.")
                  : table(
                    ["Cycle", "Status", ""],
                    repairs.items.map((cycle) => [
                      cycle.id.slice(0, 8),
                      statusChip(cycle.status),
                      cycle.status === "pending_approval"
                        ? actionButton("Review", () => { void reviewRepair(cycle).catch(report); })
                        : ""
                    ])
                  )
              )
            );
          } catch (cause) {
            report(cause);
            sections.replaceChildren(empty("Could not load Owner data."));
          } finally {
            loading = false;
            if (!disposed) refresh.disabled = false;
          }
        };

        refresh.onclick = () => { notice.textContent = ""; void load(); };
        void load();

        return {
          dispose: () => {
            disposed = true;
            root.remove();
          }
        };
      }
    });
  }
});
