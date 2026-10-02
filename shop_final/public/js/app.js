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
})();

(() => {
  const form = document.querySelector('[data-product-form]');
  if (!form) return;
  const field = name => form.querySelector(`[name="${name}"]`);
  const setState = (input, message) => {
    if (!input) return;
    const msg = input.closest('label')?.querySelector('[data-msg]');
    input.classList.toggle('is-invalid', !!message);
    input.classList.toggle('is-valid', !message && String(input.value).trim() !== '');
    if (msg) { msg.textContent = message || ''; msg.classList.toggle('is-error', !!message); }
  };
  const num = v => Number(String(v).trim().replace(',', '.'));
  const validators = {
    name: i => i.value.trim() ? '' : 'Product name is required',
    price: i => { const v = num(i.value); return !i.value.trim() ? 'Regular price is required' : (!Number.isFinite(v) || v <= 0 ? 'Price must be greater than 0' : ''); },
    stock: i => { const v = num(i.value); return !Number.isInteger(v) || v < 0 ? 'Stock must be at least 0' : ''; },
    sale: i => {
      if (!i.value.trim()) return '';
      const v = num(i.value), p = num(field('price').value);
      if (!Number.isFinite(v) || v <= 0) return 'Sale price must be greater than 0';
      return Number.isFinite(p) && p > 0 && v >= p ? 'Sale price must be lower than regular price' : '';
    },
    saleEnd: i => {
      const s = field('saleStart').value;
      return i.value && s && new Date(i.value) <= new Date(s) ? 'Sale end date must be after start date' : '';
    }
  };
  const check = input => setState(input, validators[input.dataset.field](input));
  form.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', () => { check(input); if (input.dataset.field === 'price') { const s = form.querySelector('[data-field=sale]'); if (s) check(s); } });
    input.addEventListener('blur', () => check(input));
  });
  field('saleStart')?.addEventListener('input', () => check(form.querySelector('[data-field=saleEnd]')));

  const nameInput = field('name');
  const skuInput = form.querySelector('[data-sku-input]');
  const skuMsg = form.querySelector('[data-sku-msg]');
  let skuTouched = !!skuInput?.value;
  let skuTimer;
  const slugSku = v => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const checkSku = async () => {
    const sku = skuInput.value.trim();
    if (!sku) { setState(skuInput, 'SKU is required'); return; }
    try {
      const res = await fetch(`/admin/products/check-sku?sku=${encodeURIComponent(sku)}&id=${encodeURIComponent(skuInput.dataset.productId || '')}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (skuInput.value.trim() !== sku) return;
      setState(skuInput, data.ok ? '' : data.message);
      if (data.ok && skuMsg) { skuMsg.textContent = data.message; skuMsg.classList.remove('is-error'); }
    } catch { /* server validates on submit */ }
  };
  if (skuInput) {
    skuInput.addEventListener('input', () => { skuTouched = true; clearTimeout(skuTimer); skuTimer = setTimeout(checkSku, 300); });
    nameInput?.addEventListener('input', () => {
      if (skuTouched) return;
      skuInput.value = slugSku(nameInput.value);
      clearTimeout(skuTimer); skuTimer = setTimeout(checkSku, 300);
    });
  }

  const fileInput = form.querySelector('[data-image-input]');
  const preview = form.querySelector('[data-image-preview]');
  const dropzone = form.querySelector('[data-dropzone]');
  const urlInput = form.querySelector('[data-image-url]');
  const showPreview = src => { if (!preview) return; if (src) { preview.src = src; preview.hidden = false; } else { preview.removeAttribute('src'); preview.hidden = true; } };
  const previewFile = file => {
    if (!file) return showPreview(urlInput?.value.trim().startsWith('https://') ? urlInput.value.trim() : '');
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      fileInput.value = ''; showPreview('');
      alert('Use a JPG, PNG or WebP image up to 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => showPreview(String(reader.result));
    reader.readAsDataURL(file);
  };
  fileInput?.addEventListener('change', () => previewFile(fileInput.files[0]));
  urlInput?.addEventListener('input', () => { if (!fileInput?.files.length) showPreview(urlInput.value.trim().startsWith('https://') ? urlInput.value.trim() : ''); });
  if (dropzone && fileInput) {
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('is-drag'); }));
    dropzone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const dt = new DataTransfer(); dt.items.add(file); fileInput.files = dt.files;
      previewFile(file);
    });
  }

  form.addEventListener('submit', e => {
    let firstBad = null;
    form.querySelectorAll('[data-field]').forEach(i => { check(i); if (!firstBad && i.classList.contains('is-invalid')) firstBad = i; });
    if (firstBad) { e.preventDefault(); firstBad.closest('details')?.setAttribute('open', ''); firstBad.focus(); }
  });
})();
