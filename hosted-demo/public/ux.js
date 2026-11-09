/* Stacha UI refinement. Progressive enhancement only: no API/payment changes. */
(() => {
  'use strict';
  const draftKey = 'stacha-revise-draft';
  const isWorkspace = document.body.classList.contains('ux-workspace');
  const isApp = document.body.classList.contains('ux-app');

  function restoreDraft() {
    const form = document.querySelector('#purchase-form');
    if (!form) return;
    let draft;
    try {
      draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      sessionStorage.removeItem(draftKey);
    } catch (_) { try { sessionStorage.removeItem(draftKey); } catch (_) {} return; }
    if (!draft || typeof draft.description !== 'string') return;
    const description = form.querySelector('[name="description"]');
    const budget = form.querySelector('[name="budget"]');
    const deadline = form.querySelector('[name="deadline"]');
    description.value = draft.description.slice(0, 1500);
    if (Number.isSafeInteger(draft.budgetCents) && draft.budgetCents > 0 && draft.budgetCents <= 100000000) {
      budget.value = (draft.budgetCents / 100).toFixed(2);
    }
    if (typeof draft.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.deadline) && draft.deadline >= deadline.min) {
      deadline.value = draft.deadline;
    }
    const hint = document.createElement('p');
    hint.className = 'ux-draft-hint';
    hint.role = 'status';
    hint.textContent = 'Your previous request has been loaded. You can revise it and create a new purchase; your original purchase remains saved.';
    form.parentElement.insertBefore(hint, form);
    description.focus({ preventScroll: true });
  }

  function getPurchase() {
    // workspace.js declares this state in the classic-script global lexical scope.
    try { return typeof current === 'undefined' ? null : current; }
    catch (_) { return null; }
  }

  function reviseRequest() {
    const purchase = getPurchase();
    if (!purchase || purchase.mode !== 'dynamic' || typeof purchase.description !== 'string') return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        description: purchase.description,
        budgetCents: purchase.budgetCents,
        deadline: purchase.deadline
      }));
      location.assign('/app');
    } catch (_) {
      const message = document.querySelector('#error');
      if (message) message.textContent = 'Could not keep your draft. Please copy the request before starting a new purchase.';
    }
  }

  function initNavigation() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const merchant = location.pathname.endsWith('/merchant');
    const links = merchant
      ? [['requests', 'Overview'], ['orders', 'Orders'], ['quotes', 'Quotes'], ['fulfillment', 'Activity']]
      : [['overview', 'Overview'], ['supplier-offers', 'Suppliers'], ['payments', 'Payments'], ['activity', 'Activity']];
    nav.replaceChildren(...links.map(([id, label]) => {
      const link = document.createElement('a');
      link.href = '#' + id;
      link.textContent = label;
      return link;
    }));

    function select(id) {
      for (const link of nav.querySelectorAll('a')) {
        const selected = link.hash === '#' + id;
        link.classList.toggle('active', selected);
        if (selected) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
    nav.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (link && nav.contains(link)) select(link.hash.slice(1));
    });
    window.addEventListener('hashchange', () => select(decodeURIComponent(location.hash.slice(1))));

    // Keep the active tab in sync with scrolling, including deep links.
    let scheduled = false;
    window.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        let active = links[0][0];
        let nearest = -Infinity;
        for (const [id] of links) {
          const target = document.getElementById(id);
          if (!target) continue;
          const top = target.getBoundingClientRect().top;
          if (top < 175 && top > nearest) { active = id; nearest = top; }
        }
        select(active);
      });
    }, { passive: true });
    select(links.some(([id]) => '#' + id === location.hash) ? location.hash.slice(1) : links[0][0]);
  }

  function decorateWorkspace() {
    const root = document.getElementById('workspace');
    if (!root) return;

    // Remove ornamental arrows from buttons; maintain arrows in external listing links.
    for (const button of root.querySelectorAll('button')) {
      for (const node of button.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && /\s↗\s*$/.test(node.textContent)) {
          node.textContent = node.textContent.replace(/\s↗\s*$/, '');
        }
      }
    }

    const label = root.querySelector('.workspace-head .badge.green');
    if (label && label.textContent.includes('Connected to demo')) label.textContent = 'Test supplier';

    const purchase = getPurchase();
    if (purchase?.mode === 'dynamic' && purchase.requirementsReviewRequired) {
      const nextAction = document.getElementById('recovery');
      if (nextAction && !nextAction.querySelector('[data-ux-revise]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary ux-revise';
        button.setAttribute('data-ux-revise', '');
        button.textContent = 'Revise original request';
        nextAction.append(button);
      }
    }

    // The existing supplier invites are read-only inputs. Add an actual copy action.
    for (const input of root.querySelectorAll('.invite-card input[readonly]')) {
      if (input.nextElementSibling?.matches('[data-ux-copy]')) continue;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-secondary ux-copy-button';
      copy.setAttribute('data-ux-copy', '');
      copy.textContent = 'Copy link';
      input.insertAdjacentElement('afterend', copy);
    }
  }

  if (isApp) restoreDraft();
  if (isWorkspace) {
    initNavigation();
    const root = document.getElementById('workspace');
    if (root) {
      const observer = new MutationObserver(decorateWorkspace);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      decorateWorkspace();
    }
    document.addEventListener('click', async (event) => {
      const revise = event.target.closest('[data-ux-revise]');
      if (revise) { reviseRequest(); return; }
      const copy = event.target.closest('[data-ux-copy]');
      if (!copy) return;
      const input = copy.previousElementSibling;
      if (!input || !input.matches('input[readonly]')) return;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
        else { input.select(); if (!document.execCommand('copy')) throw Error('Unable to copy'); }
        copy.textContent = 'Copied';
      } catch (_) {
        input.focus(); input.select();
        copy.textContent = 'Select and copy';
      }
    });
  }
})();
