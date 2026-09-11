import * as api from "./api-client.js";
import { createCardCreateForm } from "./card-create-form.js";
import { createCardDetail } from "./card-detail.js";
import { createFeedbackPanel } from "./feedback-panel.js";
import { createCardEditForm } from "./card-edit-form.js";
import { createCardList } from "./card-list.js";
import { createCategoryPanel } from "./category-panel.js";
import { createFilterPanel } from "./filter-panel.js";
import { createQuadrantForm } from "./quadrant-form.js";
import { createQuestionController } from "./question-controller.js";
import { createRetireForm } from "./retire-form.js";
import { createStatusBar } from "./status-bar.js";
import { createStatsPanel } from "./stats-panel.js";
import { createSupersedeForm } from "./supersede-form.js";
import { el } from "./dom.js";

/**
 * Wires the panels together and owns the mutable view state (filters, page
 * offset, selected card). Every server call reports its outcome through the
 * status bar; a rejected call never leaves the UI showing success.
 */
export function createAppController() {
  const status = createStatusBar();
  const stats = createStatsPanel({ status });
  const reloadStats = () => stats.refreshIfRequested();
  let filters = null;
  let offset = 0;
  let selectedId = null;
  let currentCard = null;
  // No page is fetched until Apply is pressed. Writes and selections must not
  // silently turn the idle list into a requested one, so every refresh path
  // goes through refreshListIfRequested().
  let listRequested = false;

  const filterPanel = createFilterPanel({
    onApply: (next) => {
      filters = next;
      offset = 0;
      listRequested = true;
      void reloadList();
    },
  });

  const list = createCardList({
    onSelect: (id) => void selectCard(id),
    onPage: (direction) => {
      const nextOffset = offset + direction * filters.limit;
      if (nextOffset < 0) return;
      offset = nextOffset;
      void reloadList();
    },
  });
  // Render the idle state before start() reaches its first await. Otherwise
  // the pager is briefly enabled while categories/stats load and can fetch a
  // page before Apply is pressed.
  list.renderIdle();

  const detail = createCardDetail({ onSelect: (id) => void selectCard(id) });
  const editForm = createCardEditForm({ onSubmit: (patch) => void applyPatch(patch, "Content saved") });
  const quadrantForm = createQuadrantForm({
    onSubmit: (patch) => void applyPatch(patch, "Quadrant saved"),
  });
  const supersedeForm = createSupersedeForm({
    onLinkExisting: (replacementId) => void linkSupersede(replacementId),
    onReplaceWithNew: () => startReplacement(),
    onUnlink: () => void applyPatch({ supersededBy: null }, "Supersede link cleared"),
  });
  const retireForm = createRetireForm({
    onRetire: () => void applyPatch({ retired: true }, "Card retired"),
    onReactivate: () => void applyPatch({ retired: false }, "Card un-retired"),
  });
  const feedbackPanel = createFeedbackPanel({
    onSend: (rating, note) => sendFeedback(rating, note),
  });
  feedbackPanel.renderEmpty();
  const createForm = createCardCreateForm({
    onSubmit: (card, supersedeTargetId) => void submitNewCard(card, supersedeTargetId),
  });
  const categoryPanel = createCategoryPanel({
    onCreate: (name, description) => void submitCategory(name, description),
  });
  const questionController = createQuestionController({
    status,
    onAnswerApplied: async (cardId) => {
      await Promise.all([reloadStats(), refreshListIfRequested()]);
      await showCard(cardId);
    },
    onSelectCard: (id) => void selectCard(id),
  });

  const editors = el("div", { className: "editors hidden" }, [
    editForm.element,
    quadrantForm.element,
    supersedeForm.element,
    retireForm.element,
  ]);

  const element = el("div", { className: "layout" }, [
    el("header", { className: "app-header" }, [
      el("h1", { textContent: "Genius card review" }),
      stats.element,
      status.element,
    ]),
    el("div", { className: "columns" }, [
      el("div", { className: "column left" }, [filterPanel.element, list.element]),
      el("div", { className: "column right" }, [
        detail.element,
        feedbackPanel.element,
        editors,
        questionController.element,
        createForm.element,
        categoryPanel.element,
      ]),
    ]),
  ]);

  /** @implements SPEC-UI-LAZY-LIST */
  async function start() {
    filters = filterPanel.read();
    // Only the small category vocabulary loads automatically. Statistics scan
    // the card database; questions create editable rows. Both are explicit.
    await Promise.all([reloadCategories(), questionController.start()]);
    // The controls are usable while the header requests are in flight. Do not
    // overwrite a page that was explicitly requested during that interval.
    if (!listRequested) list.renderIdle();
  }

  async function reloadCategories() {
    try {
      const body = await api.listCategories();
      filterPanel.setCategories(body.categories);
      editForm.setCategories(body.categories);
      createForm.setCategories(body.categories);
      categoryPanel.setCategories(body.categories);
    } catch (error) {
      status.failure("Failed to load categories", error);
    }
  }

  async function reloadList() {
    try {
      const body = await api.listCards({ ...filters, offset });
      list.render(body.cards, { offset, limit: filters.limit, selectedId });
    } catch (error) {
      status.failure("Failed to list cards", error);
    }
  }

  /** @implements SPEC-UI-LAZY-LIST */
  async function refreshListIfRequested() {
    if (!listRequested) return;
    await reloadList();
  }

  /** @implements SPEC-UI-LAZY-LIST */
  async function selectCard(id) {
    const loaded = await showCard(id);
    if (loaded) status.info(`Loaded card ${id}`);
    await refreshListIfRequested();
  }

  /**
   * Reads the card plus its chain and fills the detail view and every editor
   * from the stored state. Returns false (and reports) when the read fails.
   *
   * @implements SPEC-GENIUS-CARD-FEEDBACK-UI
   */
  async function showCard(id) {
    try {
      const [card, chain, feedback] = await Promise.all([
        api.getCard(id),
        api.getSupersedeChain(id),
        api.getCardFeedback(id),
      ]);
      currentCard = card;
      selectedId = card.id;
      detail.render(card, chain);
      feedbackPanel.render(feedback);
      editForm.setCard(card);
      quadrantForm.setCard(card);
      supersedeForm.setCard(card);
      retireForm.setCard(card);
      editors.className = "editors";
      return true;
    } catch (error) {
      status.failure(`Failed to load card ${id}`, error);
      return false;
    }
  }

  /**
   * 評価を送り、集計と (アーカイブされたなら) カード状態を取り直す。
   * poor が閾値を超えると送信そのものでカードが retire されるので、
   * 送りっぱなしにせず表示を更新する (spec/feature/card-feedback.md §4)。
   */
  async function sendFeedback(rating, note) {
    if (selectedId === null) {
      status.error("Select a card first.");
      return;
    }
    const id = selectedId;
    const result = await api.sendCardFeedback(id, rating, note);
    if (result.archived) {
      status.info(`Card ${id} was archived: poor feedback passed the threshold.`);
      await showCard(id);
      await refreshListIfRequested();
      return;
    }
    status.info(`Feedback recorded: ${rating}`);
    feedbackPanel.render(await api.getCardFeedback(id));
  }

  async function applyPatch(patch, successMessage) {
    if (selectedId === null) {
      status.error("Select a card first.");
      return;
    }
    if (Object.keys(patch).length === 0) {
      status.info("Nothing changed.");
      return;
    }
    const expectedVisibility = patch.visibility ?? currentCard?.visibility;
    try {
      const card = await api.patchCard(selectedId, patch);
      // The gate re-checks public content and may store it as sensitive. That is
      // a different outcome than what was asked for, so report it as such
      // instead of a plain success.
      if (expectedVisibility === "public" && card.visibility !== "public") {
        status.error(`Card saved but the sensitive check stored it as ${card.visibility}.`);
      } else {
        status.info(successMessage);
      }
      await refreshAfterWrite(card.id);
    } catch (error) {
      status.failure("Patch rejected", error);
      // Re-read so the forms show the stored state, never the refused edit.
      await refreshAfterWrite(selectedId);
    }
  }

  async function linkSupersede(replacementId) {
    if (replacementId === "") {
      status.error("Enter the id of the replacement card.");
      return;
    }
    await applyPatch({ supersededBy: replacementId }, `Retired in favour of ${replacementId}`);
  }

  function startReplacement() {
    if (selectedId === null) {
      status.error("Select a card first.");
      return;
    }
    createForm.setSupersedeTarget(currentCard);
    status.info("Fill in the replacement card, then press Create card.");
  }

  /** @implements SPEC-UI-LAZY-LIST */
  async function submitNewCard(card, supersedeTargetId) {
    let created;
    try {
      created = await api.createCard(card);
    } catch (error) {
      status.failure("Create rejected", error);
      return;
    }
    if (created.situation !== card.situation) {
      status.error(
        `sourceRef already exists; the stored card ${created.id} was returned unchanged.`,
      );
    } else if (card.visibility === "public" && created.visibility !== "public") {
      status.error(`Card ${created.id} was created but the sensitive check kept it sensitive.`);
    } else {
      status.info(`Created card ${created.id}`);
    }
    // The link is a second call and can fail on its own (the target may already
    // be superseded). The card was written either way, so the failure is
    // reported as the link failing — never as the creation failing — and the
    // view is still refreshed onto the new card.
    if (supersedeTargetId !== null && created.id !== supersedeTargetId) {
      try {
        await api.patchCard(supersedeTargetId, { supersededBy: created.id });
        status.info(`Created card ${created.id} and retired ${supersedeTargetId}`);
      } catch (error) {
        status.failure(`Created card ${created.id} but linking ${supersedeTargetId} failed`, error);
      }
    }
    createForm.setSupersedeTarget(null);
    // showCard (not selectCard) so the outcome reported above survives:
    // selectCard would overwrite it with its own "Loaded card" message.
    await showCard(created.id);
    await Promise.all([reloadStats(), refreshListIfRequested()]);
  }

  async function submitCategory(name, description) {
    if (name === "" || description === "") {
      status.error("Category name and description are both required.");
      return;
    }
    try {
      await api.createCategory(name, description);
      categoryPanel.reset();
      status.info(`Added category ${name}`);
      await reloadCategories();
    } catch (error) {
      status.failure("Category rejected", error);
    }
  }

  /** @implements SPEC-UI-LAZY-LIST */
  async function refreshAfterWrite(id) {
    await Promise.all([reloadStats(), refreshListIfRequested()]);
    await showCard(id);
  }

  return { element, start };
}
