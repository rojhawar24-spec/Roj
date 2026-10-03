(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  // Mobile navigation: keyboard friendly, closes on escape and after navigation.
  const menu = document.querySelector('[data-menu-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (menu && nav) {
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    };
    menu.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    document.addEventListener('click', e => {
      if (nav.classList.contains('open') && !nav.contains(e.target) && !menu.contains(e.target)) setOpen(false);
    });
  }

  document.querySelectorAll('[data-print-order]').forEach(button => button.addEventListener('click', () => window.print()));

  document.querySelectorAll('[data-confirm]').forEach(form => form.addEventListener('submit', e => {
    const message = form.getAttribute('data-confirm') || 'Are you sure?';
    if (!window.confirm(message)) e.preventDefault();
  }));

  // Prevent accidental double submits on payment/irreversible forms.
  document.querySelectorAll('[data-submit-once]').forEach(form => form.addEventListener('submit', () => {
    if (!form.checkValidity()) return;
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    if (submit) {
      submit.disabled = true;
      submit.dataset.originalText = submit.textContent;
      submit.textContent = 'Opening secure payment…';
    }
  }));

  const searchInputs = document.querySelectorAll('[data-search-input]');
  const searchBoxes = document.querySelectorAll('[data-search-box]');
  searchInputs.forEach(input => {
    const box = input.closest('[data-search-box]');
    const results = box?.querySelector('[data-search-results]');
    let timer;
    let controller;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      controller?.abort();
      const q = input.value.trim();
      if (!results) return;
      if (q.length < 2) { results.replaceChildren(); results.hidden = true; return; }
      timer = setTimeout(async () => {
        controller = new AbortController();
        results.setAttribute('aria-busy', 'true');
        try {
          const res = await fetch('/api/search?q=' + encodeURIComponent(q), {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
          });
          const data = await res.json();
          results.replaceChildren();
          if (!res.ok) throw new Error('Search failed');
          if (!Array.isArray(data.results) || !data.results.length) {
            const empty = document.createElement('div');
            empty.className = 'search-empty';
            empty.textContent = 'No matching products';
            results.append(empty);
          } else {
            data.results.forEach(item => {
              const link = document.createElement('a');
              link.className = 'search-result';
              link.href = '/product/' + encodeURIComponent(String(item.slug || ''));
              const image = document.createElement('img');
              image.src = String(item.image || '/assets/product-placeholder.svg');
              image.alt = '';
              image.loading = 'lazy';
              image.decoding = 'async';
              const copy = document.createElement('span');
              const name = document.createElement('strong');
              name.textContent = String(item.name || '');
              const meta = document.createElement('small');
              meta.textContent = String(item.price || '') + (item.discount ? ` · -${Number(item.discount)}%` : '');
              copy.append(name, meta);
              link.append(image, copy);
              results.append(link);
            });
          }
          results.hidden = false;
        } catch (error) {
          if (error?.name !== 'AbortError') results.hidden = true;
        } finally {
          results.removeAttribute('aria-busy');
        }
      }, 160);
    });
  });
  document.addEventListener('click', e => {
    searchBoxes.forEach(box => {
      if (!box.contains(e.target)) {
        const r = box.querySelector('[data-search-results]');
        if (r) r.hidden = true;
      }
    });
  });

  document.querySelectorAll('[data-wishlist-toggle]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.productId;
      button.disabled = true;
      try {
        const body = new URLSearchParams({ _csrf: csrf, productId: id });
        const res = await fetch('/wishlist/toggle', {
          method: 'POST',
          headers: { 'x-csrf-token': csrf, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body
        });
        if (res.status === 401 || res.redirected) { window.location.href = '/login'; return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Wishlist error');
        button.classList.toggle('saved', data.saved);
        button.setAttribute('aria-pressed', String(data.saved));
        button.textContent = data.saved ? '♥' : '♡';
        button.setAttribute('aria-label', data.saved ? 'Remove from wishlist' : 'Add to wishlist');
        document.querySelectorAll('[data-wishlist-count]').forEach(el => { el.textContent = data.count; });
      } catch {
        // Keep the previous visual state when the request fails.
      } finally { button.disabled = false; }
    });
  });

  const ask = document.querySelector('[data-ai-ask]');
  const input = document.getElementById('ai-input');
  const answer = document.getElementById('ai-answer');
  if (ask && input && answer) {
    const run = async () => {
      const message = input.value.trim();
      if (!message) return;
      ask.disabled = true;
      answer.textContent = 'Thinking…';
      try {
        const res = await fetch('/api/ai/search-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Accept': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await res.json();
        answer.textContent = data.answer || data.error || 'No answer available.';
      } catch { answer.textContent = 'The assistant is unavailable right now.'; }
      finally { ask.disabled = false; }
    };
    ask.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  }

  const priceInput = document.querySelector('[data-price-input]');
  const saleInput = document.querySelector('[data-sale-input]');
  const productDiscountInput = document.querySelector('[name=automaticDiscountPercent]');
  const discountPreview = document.querySelector('[data-discount-preview]');
  const updateDiscountPreview = () => {
    if (!priceInput || !saleInput || !productDiscountInput || !discountPreview) return;
    const price = Number(String(priceInput.value).replace(',', '.'));
    const sale = Number(String(saleInput.value).replace(',', '.'));
    const pct = Number(productDiscountInput.value);
    if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(pct) || pct < 0 || pct > 90) {
      discountPreview.textContent = '';
      return;
    }
    const base = Number.isFinite(sale) && sale > 0 && sale < price ? sale : price;
    const finalCents = Math.max(1, Math.floor(base * (100 - pct) / 100));
    const totalOff = Math.round((1 - finalCents / 100 / price) * 100);
    const currency = document.querySelector('[data-shop-currency]')?.getAttribute('data-shop-currency') || 'EUR';
    let formatted = `${(finalCents / 100).toFixed(2)} ${currency}`;
    try { formatted = new Intl.NumberFormat('en-GB', { style:'currency', currency }).format(finalCents / 100); } catch {}
    discountPreview.textContent = pct > 0 ? `Final customer price preview: ${formatted} · total discount about ${totalOff}%` : 'No automatic item discount.';
  };
  priceInput?.addEventListener('input', updateDiscountPreview);
  saleInput?.addEventListener('input', updateDiscountPreview);
  productDiscountInput?.addEventListener('input', updateDiscountPreview);
  updateDiscountPreview();

  // =========================================================
  // Smart back button
  // Uses history.back() only when the previous page is on the
  // same origin, otherwise falls back to the button's data-fallback URL.
  // =========================================================
  document.querySelectorAll('[data-smart-back]').forEach(button => {
    button.addEventListener('click', () => {
      const fallback = button.dataset.fallback || '/shop';
      const referrer = document.referrer;

      try {
        const url = new URL(referrer);
        if (url.origin === window.location.origin && history.length > 1) {
          history.back();
          return;
        }
      } catch {}

      window.location.href = fallback;
    });
  });
})();