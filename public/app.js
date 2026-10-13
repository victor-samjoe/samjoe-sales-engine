(() => {
  'use strict';

  const stageLabels = {
    prospect: 'Prospect', invited: 'Convidado', opted_in: 'Opt-in confirmado',
    interested: 'Interessado', first_buyer: 'Primeira compra',
    repeat_buyer: 'Cliente recorrente', inactive: 'Inativo', blocked: 'Bloqueado',
  };
  const originLabels = {
    manual: 'Manual', manual_crm: 'CRM', whatsapp: 'WhatsApp', instagram: 'Instagram',
    indicacao: 'Indicação', site: 'Site', formulario: 'Formulário',
  };
  const viewLabels = {
    dashboard: 'Visão geral', contacts: 'Contatos', products: 'Produtos',
    campaigns: 'Campanhas', queue: 'Fila de disparos', results: 'Resultados',
    publicos: 'Públicos', integrations: 'Integrações', settings: 'Configurações',
  };
  const deliveryStatusLabels = {
    pending: 'Pendente', queued: 'Na fila', sent: 'Enviado',
    delivered: 'Entregue', read: 'Lido', failed: 'Falhou', cancelled: 'Cancelado',
  };
  const deliveryStatusClass = {
    pending: 'neutral', queued: 'accent', sent: 'success',
    delivered: 'success', read: 'success', failed: 'danger', cancelled: 'neutral',
  };
  const campaignStatusLabels = {
    draft: 'Rascunho', preflight_ready: 'Análise pronta', approved: 'Aprovada',
    scheduled: 'Agendada', sending: 'Enviando', completed: 'Concluída', cancelled: 'Cancelada',
  };
  const campaignStatusClass = {
    draft: 'neutral', preflight_ready: 'accent', approved: 'success',
    scheduled: 'success', sending: 'success', completed: 'neutral', cancelled: 'danger',
  };
  const exclusionLabels = {
    invalid_phone: 'Telefone inválido', do_not_contact: 'Não contatar', blocked: 'Bloqueado',
    marketing_consent_missing: 'Sem consentimento', cooldown: 'Em cooldown',
    frequency_cap: 'Limite de frequência', stage_not_selected: 'Etapa excluída',
    origin_not_selected: 'Origem excluída', tag_not_selected: 'Tag ausente', already_converted: 'Já convertido',
  };
  const state = {
    token: sessionStorage.getItem('samjoe_crm_token') || '',
    user: null,
    contacts: [],
    products: [],
    campaigns: [],
    audiences: [],
    editingCampaignId: null,
    editingAudienceId: null,
    activeView: 'dashboard',
    queue: { data: [], total: 0, offset: 0, status: '', campaignId: '' },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  const money = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number(cents) || 0) / 100);
  const shortDate = (date) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
  const relativeDate = (date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
    if (days <= 0) return 'Hoje';
    if (days === 1) return 'Ontem';
    if (days < 30) return `${days} dias`;
    return shortDate(date);
  };

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/v1/auth/login') logout(false);
      throw new Error(payload.error?.message || `Erro ${response.status}`);
    }
    return payload;
  }

  function setButtonLoading(button, loading, label = 'Salvando...') {
    if (!button) return;
    if (loading) {
      button.dataset.original = button.innerHTML;
      button.textContent = label;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.original || button.innerHTML;
      button.disabled = false;
    }
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('#toastRegion').append(node);
    window.setTimeout(() => node.remove(), 3800);
  }

  async function checkHealth() {
    const dot = $('#apiDot');
    try {
      const result = await api('/health');
      const healthy = result.status === 'ok' && result.database === 'ok';
      dot.classList.toggle('ok', healthy);
      $('#apiStateText').textContent = healthy ? 'API e banco online' : 'Serviço degradado';
      $('#apiBadge').textContent = healthy ? 'Online' : 'Degradada';
      $('#apiBadge').className = `status-badge ${healthy ? 'success' : 'danger'}`;
    } catch {
      dot.classList.remove('ok');
      $('#apiStateText').textContent = 'API indisponível';
      $('#apiBadge').textContent = 'Offline';
      $('#apiBadge').className = 'status-badge danger';
    }
    checkWaHealth();
    checkN8nHealth();
  }

  async function checkWaHealth() {
    const dot = $('#waHealthDot');
    const text = $('#waHealthText');
    const badge = $('#waBadge');
    const disconnectBtn = $('#waDisconnectBtn');
    const connectBtn = $('#waConfigBtn');
    if (!dot) return;
    try {
      const result = await api('/api/v1/integrations/whatsapp/status');
      const waState = result.data?.state;
      if (waState === 'open') {
        dot.className = 'health-dot ok';
        if (text) text.textContent = 'Conectado';
        if (badge) { badge.textContent = 'Conectado'; badge.className = 'status-badge success'; }
        if (disconnectBtn) disconnectBtn.classList.remove('is-hidden');
        if (connectBtn) connectBtn.textContent = 'Reconectar';
      } else if (waState === 'connecting') {
        dot.className = 'health-dot warn';
        if (text) text.textContent = 'Conectando…';
        if (badge) { badge.textContent = 'Conectando'; badge.className = 'status-badge accent'; }
        if (disconnectBtn) disconnectBtn.classList.add('is-hidden');
        if (connectBtn) connectBtn.textContent = 'Conectar';
      } else {
        dot.className = 'health-dot fail';
        if (text) text.textContent = waState === 'offline' ? 'API offline' : 'Desconectado';
        if (badge) { badge.textContent = waState === 'offline' ? 'Offline' : 'Desconectado'; badge.className = 'status-badge danger'; }
        if (disconnectBtn) disconnectBtn.classList.add('is-hidden');
        if (connectBtn) connectBtn.textContent = 'Conectar';
      }
    } catch {
      dot.className = 'health-dot fail';
      if (text) text.textContent = 'Indisponível';
      if (badge) { badge.textContent = 'Offline'; badge.className = 'status-badge danger'; }
      if (disconnectBtn) disconnectBtn.classList.add('is-hidden');
    }
  }

  async function checkN8nHealth() {
    const url = (localStorage.getItem('n8nApiUrl') || 'http://localhost:5679').replace(/\/$/, '');
    const dot = $('#n8nHealthDot');
    const text = $('#n8nHealthText');
    const badge = $('#n8nBadge');
    if (!dot) return;
    try {
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${url}/healthz`, { mode: 'no-cors', signal: ctrl.signal });
      window.clearTimeout(tid);
      dot.className = 'health-dot ok';
      if (text) text.textContent = 'Motor online';
      if (badge) { badge.textContent = 'Online'; badge.className = 'status-badge success'; }
    } catch {
      dot.className = 'health-dot fail';
      if (text) text.textContent = 'Motor offline';
      if (badge) { badge.textContent = 'Offline'; badge.className = 'status-badge danger'; }
    }
  }

  async function login(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('#loginError');
    error.textContent = '';
    setButtonLoading(submit, true, 'Entrando...');
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.token = result.access_token;
      state.user = result.user;
      sessionStorage.setItem('samjoe_crm_token', state.token);
      await enterApp();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  function logout(showMessage = true) {
    state.token = '';
    state.user = null;
    state.contacts = [];
    state.products = [];
    sessionStorage.removeItem('samjoe_crm_token');
    $('#appShell').classList.add('is-hidden');
    $('#loginScreen').classList.remove('is-hidden');
    $('#passwordInput').value = '';
    if (showMessage) toast('Sessão encerrada.');
  }

  async function enterApp() {
    $('#loginScreen').classList.add('is-hidden');
    $('#appShell').classList.remove('is-hidden');
    $('#userEmail').textContent = state.user?.email || 'Usuário';
    $('#userRole').textContent = state.user?.role || 'Operação local';
    $('#userInitial').textContent = initials(state.user?.email || 'S');
    $('#welcomeName').textContent = 'time SamJoE';
    await loadData();
  }

  async function restoreSession() {
    if (!state.token) return;
    try {
      state.user = await api('/api/v1/me');
      await enterApp();
    } catch {
      logout(false);
    }
  }

  async function loadData(showConfirmation = false) {
    $('#refreshButton').classList.add('is-spinning');
    try {
      const [contactsResult, productsResult, campaignsResult] = await Promise.all([
        api('/api/v1/contacts?limit=200'),
        api('/api/v1/products'),
        api('/api/v1/campaigns'),
      ]);
      state.contacts = contactsResult.data || [];
      state.products = productsResult.data || [];
      state.campaigns = campaignsResult.data || [];
      renderAll();
      loadSamJoeFoodConfig().catch(() => {});
      if (showConfirmation) toast('Dados atualizados.');
    } catch (err) {
      toast(`Não foi possível carregar os dados: ${err.message}`, 'error');
    } finally {
      $('#refreshButton').classList.remove('is-spinning');
      checkHealth();
    }
  }

  function renderAll() {
    renderMetrics();
    renderStages();
    renderRecent();
    renderContacts();
    renderProducts();
    renderCampaigns();
    $('#contactNavCount').textContent = String(state.contacts.length);
    $('#campaignNavCount').textContent = String(state.campaigns.length);
  }

  function renderMetrics() {
    const monthAgo = Date.now() - 30 * 86400000;
    const prospects = state.contacts.filter((contact) => ['prospect', 'invited', 'opted_in', 'interested'].includes(contact.stage)).length;
    const newContacts = state.contacts.filter((contact) => new Date(contact.created_at).getTime() >= monthAgo).length;
    $('#metricContacts').textContent = String(state.contacts.length);
    $('#metricNewContacts').textContent = `${newContacts} ${newContacts === 1 ? 'novo' : 'novos'}`;
    $('#metricProspects').textContent = String(prospects);
    $('#metricProducts').textContent = String(state.products.filter((product) => product.active).length);
    $('#metricOptOut').textContent = String(state.contacts.filter((contact) => contact.do_not_contact).length);
  }

  function renderStages() {
    const counts = Object.keys(stageLabels).map((stage) => ({
      stage, count: state.contacts.filter((contact) => contact.stage === stage).length,
    }));
    const max = Math.max(...counts.map(({ count }) => count), 1);
    $('#stageList').innerHTML = counts.map(({ stage, count }) => `
      <div class="stage-row">
        <span>${stageLabels[stage]}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${(count / max) * 100}%"></div></div>
        <b>${count}</b>
      </div>`).join('');
  }

  function renderRecent() {
    const recent = state.contacts.slice(0, 5);
    $('#recentContacts').innerHTML = recent.length ? recent.map((contact) => `
      <div class="activity-item">
        <span class="avatar">${escapeHtml(initials(contact.full_name))}</span>
        <span><strong>${escapeHtml(contact.full_name)}</strong><small>${escapeHtml(originLabels[contact.origin] || contact.origin)} · ${escapeHtml(stageLabels[contact.stage] || contact.stage)}</small></span>
        <time>${relativeDate(contact.created_at)}</time>
      </div>`).join('') : '<p class="list-placeholder">Os contatos recém-cadastrados aparecerão aqui.</p>';
  }

  function filteredContacts() {
    const search = $('#contactSearch').value.trim().toLowerCase();
    const stage = $('#stageFilter').value;
    return state.contacts.filter((contact) => {
      const haystack = `${contact.full_name} ${contact.phone_e164 || ''} ${contact.email || ''}`.toLowerCase();
      return (!search || haystack.includes(search)) && (!stage || contact.stage === stage);
    });
  }

  function renderContacts() {
    const contacts = filteredContacts();
    const body = $('#contactsTableBody');
    body.innerHTML = contacts.map((contact) => `
      <tr>
        <td><div class="contact-cell"><span class="avatar">${escapeHtml(initials(contact.full_name))}</span><span><strong>${escapeHtml(contact.full_name)}</strong><small>${escapeHtml(contact.phone_e164 || contact.email || 'Sem telefone ou e-mail')}</small></span></div></td>
        <td><span class="stage-badge ${escapeHtml(contact.stage)}">${escapeHtml(stageLabels[contact.stage] || contact.stage)}</span></td>
        <td>${escapeHtml(originLabels[contact.origin] || contact.origin)}</td>
        <td><span class="permission ${contact.do_not_contact ? 'blocked' : 'ok'}">${contact.do_not_contact ? '● Bloqueado' : '● Permitido'}</span></td>
        <td>${shortDate(contact.created_at)}</td>
        <td><button class="row-action" data-consent-id="${contact.id}" data-consent-name="${escapeHtml(contact.full_name)}">Consentimento</button></td>
      </tr>`).join('');
    const empty = !contacts.length;
    $('#contactsEmpty').classList.toggle('is-hidden', !empty);
    $('.table-wrap', body.closest('.table-panel')).classList.toggle('is-hidden', empty);
  }

  function filteredCampaigns() {
    const activeStatuses = $$('.filter-chip.is-active').map((el) => el.dataset.status);
    const from = $('#campaignDateFrom')?.value || '';
    const to = $('#campaignDateTo')?.value || '';
    return state.campaigns.filter((c) => {
      if (activeStatuses.length && !activeStatuses.includes(c.status)) return false;
      const day = (c.created_at || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
  }

  function renderCampaigns() {
    const campaigns = filteredCampaigns();
    const body = $('#campaignsTableBody');
    body.innerHTML = campaigns.map((c) => {
      const canAnalyse = c.status === 'draft' || c.status === 'preflight_ready';
      const canApprove = c.status === 'preflight_ready';
      const canCancel = !['completed', 'cancelled'].includes(c.status);
      const canEdit = c.status === 'draft' || c.status === 'preflight_ready';
      const canView = c.status !== 'draft';
      const actions = [
        canEdit ? `<button class="row-action" data-edit-id="${c.id}">Editar</button>` : '',
        canAnalyse ? `<button class="row-action" data-preflight-id="${c.id}" data-preflight-name="${escapeHtml(c.name)}">Analisar</button>` : '',
        canApprove ? `<button class="row-action approve" data-approve-id="${c.id}" data-approve-name="${escapeHtml(c.name)}">Aprovar</button>` : '',
        canView ? `<button class="row-action view" data-view-campaign-id="${c.id}">Visualizar</button>` : '',
        canCancel && c.status !== 'draft' ? `<button class="row-action cancel" data-cancel-id="${c.id}" data-cancel-name="${escapeHtml(c.name)}">Cancelar</button>` : '',
        `<button class="row-action" data-clone-id="${c.id}" data-clone-name="${escapeHtml(c.name)}">Clonar</button>`,
      ].filter(Boolean).join(' ');
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong>${c.objective ? `<br><small class="muted">${escapeHtml(c.objective)}</small>` : ''}</td>
        <td><span class="status-badge ${escapeHtml(campaignStatusClass[c.status] || 'neutral')}">${escapeHtml(campaignStatusLabels[c.status] || c.status)}</span></td>
        <td>${canAnalyse && !c.snapshot_hash ? '<span class="muted">—</span>' : escapeHtml(String(c.eligible_count ?? 0))}</td>
        <td class="campaign-msg">${escapeHtml((c.message_text || '').slice(0, 90))}</td>
        <td>${shortDate(c.created_at)}</td>
        <td><div style="display:flex;gap:3px;flex-wrap:wrap;align-items:center">${actions}</div></td>
      </tr>`;
    }).join('');
    const empty = !campaigns.length;
    $('#campaignsEmpty').classList.toggle('is-hidden', !empty);
    $('.table-wrap', $('#campaignsTableBody').closest('.table-panel')).classList.toggle('is-hidden', empty);
  }

  async function loadQueue() {
    const { status, campaignId } = state.queue;
    const params = new URLSearchParams({ limit: '50', offset: String(state.queue.offset) });
    if (status) params.set('status', status);
    if (campaignId) params.set('campaign_id', campaignId);
    try {
      const result = await api(`/api/v1/dispatch/recipients?${params}`);
      state.queue.data = result.data || [];
      state.queue.total = result.total || 0;
      renderQueue();
    } catch (err) {
      toast(`Erro ao carregar fila: ${err.message}`, 'error');
    }
  }

  function renderQueue() {
    const { data, total, offset } = state.queue;
    const body = $('#queueTableBody');
    const fmt = (ts) => ts ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '—';
    body.innerHTML = data.map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.campaign_name)}</strong></td>
        <td>${escapeHtml(r.full_name)}</td>
        <td style="font-size:12px;color:var(--muted)">${escapeHtml(r.phone_e164 || '—')}</td>
        <td><span class="status-badge ${escapeHtml(deliveryStatusClass[r.delivery_status] || 'neutral')}">${escapeHtml(deliveryStatusLabels[r.delivery_status] || r.delivery_status)}</span></td>
        <td style="font-size:12px">${fmt(r.queued_at)}</td>
        <td style="font-size:12px">${fmt(r.sent_at)}</td>
        <td style="font-size:12px">${fmt(r.delivered_at)}</td>
        <td style="font-size:12px">${fmt(r.read_at)}</td>
      </tr>`).join('');
    const empty = !data.length;
    $('#queueEmpty').classList.toggle('is-hidden', !empty);
    $('.table-wrap', $('#queueTableBody').closest('.table-panel')).classList.toggle('is-hidden', empty);

    const pg = $('#queuePagination');
    if (total > 50) {
      const page = Math.floor(offset / 50) + 1;
      const pages = Math.ceil(total / 50);
      pg.innerHTML = `
        <button class="secondary-button small" id="queuePrev" ${offset === 0 ? 'disabled' : ''}>← Anterior</button>
        <span style="font-size:12px;color:var(--muted)">Página ${page} de ${pages} · ${total} registros</span>
        <button class="secondary-button small" id="queueNext" ${offset + 50 >= total ? 'disabled' : ''}>Próxima →</button>`;
      $('#queuePrev')?.addEventListener('click', () => { state.queue.offset -= 50; loadQueue(); });
      $('#queueNext')?.addEventListener('click', () => { state.queue.offset += 50; loadQueue(); });
    } else {
      pg.innerHTML = total > 0 ? `<span style="font-size:12px;color:var(--muted)">${total} registro${total !== 1 ? 's' : ''}</span>` : '';
    }
  }

  function populateQueueCampaignFilter() {
    const sel = $('#queueCampaignFilter');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Todas as campanhas</option>';
    state.campaigns.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === current) opt.selected = true;
      sel.append(opt);
    });
  }

  function renderProducts() {
    const search = $('#productSearch').value.trim().toLowerCase();
    const products = state.products.filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(search));
    $('#productGrid').innerHTML = products.map((product) => `
      <article class="product-card">
        <div class="product-top"><div class="product-icon">◇</div><span class="status-badge ${product.active ? 'success' : 'neutral'}">${product.active ? 'Ativo' : 'Inativo'}</span></div>
        <h3>${escapeHtml(product.name)}</h3><span class="sku">${escapeHtml(product.sku)} · ${escapeHtml(product.category)}</span>
        <div class="product-price"><span>PREÇO<strong>${money(product.current_price_cents)}</strong></span><span>CUSTO EST.<small>${product.current_estimated_unit_cost_cents == null ? 'Não informado' : money(product.current_estimated_unit_cost_cents)}</small></span></div>
      </article>`).join('');
    $('#productsEmpty').classList.toggle('is-hidden', products.length > 0);
  }

  function navigate(view) {
    if (!viewLabels[view]) return;
    if (state.activeView !== view) closeModal();
    state.activeView = view;
    $$('.view').forEach((node) => node.classList.remove('is-active'));
    $(`#${view}View`).classList.add('is-active');
    $$('.nav-item').forEach((node) => node.classList.toggle('is-active', node.dataset.view === view));
    $('#pageTitle').textContent = viewLabels[view];
    $('#breadcrumb').textContent = viewLabels[view].toUpperCase();
    $('#sidebar').classList.remove('is-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (view === 'results') loadAnalytics().catch(() => {});
    if (view === 'settings') loadSettings().catch(() => {});
    if (view === 'queue') { populateQueueCampaignFilter(); loadQueue().catch(() => {}); }
    if (view === 'publicos') loadPublicos().catch(() => {});
    if (view === 'integrations') detectSamJoeFood().catch(() => {});
  }

  function openModal(type, detail = {}) {
    const modal = $(`#${type}Modal`);
    if (!modal) return;
    $$('.modal').forEach((node) => node.classList.remove('is-active'));
    modal.classList.add('is-active');
    $('#modalBackdrop').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    if (type === 'consent') {
      $('[name="contactId"]', modal).value = detail.id;
      $('#consentContactName').textContent = detail.name;
    }
    window.setTimeout(() => $('input:not([type="hidden"]), select', modal)?.focus(), 30);
  }

  function closeModal() {
    state.editingCampaignId = null;
    const cm = $('#campaignModal');
    if (cm) {
      cm.querySelector('.eyebrow').textContent = 'NOVA CAMPANHA';
      cm.querySelector('#campaignModalTitle').textContent = 'Criar campanha';
      const submitBtn = cm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.textContent = 'Criar campanha';
    }
    $('#modalBackdrop').classList.add('is-hidden');
    $$('.modal').forEach((node) => node.classList.remove('is-active'));
    document.body.style.overflow = '';
    resetAssetUpload();
  }

  async function submitContact(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      fullName: values.fullName.trim(), origin: values.origin, stage: values.stage,
      ...(values.phone.trim() ? { phone: values.phone.trim() } : {}),
      ...(values.email.trim() ? { email: values.email.trim() } : {}),
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    setButtonLoading(submit, true);
    try {
      await api('/api/v1/contacts', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      $('[name="origin"]', form).value = 'manual';
      $('[name="stage"]', form).value = 'prospect';
      closeModal();
      await loadData();
      toast('Contato criado com sucesso.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function submitProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      sku: values.sku.trim(), name: values.name.trim(), category: values.category.trim(),
      currentPriceCents: Math.round(Number(values.price) * 100),
      ...(values.cost ? { currentEstimatedUnitCostCents: Math.round(Number(values.cost) * 100) } : {}),
      ...(values.costSource.trim() ? { costSource: values.costSource.trim() } : {}),
    };
    setButtonLoading(submit, true);
    try {
      await api('/api/v1/products', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      closeModal();
      await loadData();
      toast('Produto criado com sucesso.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function submitCampaign(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const splitTrimmed = (str) => (str || '').split(',').map((s) => s.trim()).filter(Boolean);
    const audienceRules = {
      ...(splitTrimmed(values.audienceStages).length ? { stages: splitTrimmed(values.audienceStages) } : {}),
      ...(splitTrimmed(values.audienceOrigins).length ? { origins: splitTrimmed(values.audienceOrigins) } : {}),
      ...(splitTrimmed(values.audienceTags).length ? { tagsAny: splitTrimmed(values.audienceTags) } : {}),
    };
    const assetType = values.assetType;
    const assetUrl = values.assetUrl?.trim();
    const assets = assetType && assetUrl ? [{ type: assetType, url: assetUrl }] : [];
    const isSingle = values.dispatchMode === 'single';
    const payload = {
      name: values.name.trim(), messageText: values.messageText.trim(),
      ...(values.objective?.trim() ? { objective: values.objective.trim() } : {}),
      ...(values.linkUrl?.trim() ? { linkUrl: values.linkUrl.trim() } : {}),
      ...(assets.length ? { assets } : {}),
      dispatchMode: isSingle ? 'single' : 'standard',
      ...(isSingle ? {} : {
        minIntervalHours: Number(values.minIntervalHours),
        maxNotificationsPer30d: Number(values.maxNotificationsPer30d),
        includeConverted: values.includeConverted === 'on',
      }),
      audienceRules,
    };
    const editingId = state.editingCampaignId;
    setButtonLoading(submit, true, editingId ? 'Salvando...' : 'Criando...');
    try {
      if (editingId) {
        await api(`/api/v1/campaigns/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Campanha atualizada.');
      } else {
        await api('/api/v1/campaigns', { method: 'POST', body: JSON.stringify(payload) });
        toast('Campanha criada com sucesso.');
      }
      form.reset();
      $('[name="includeConverted"]', form).checked = true;
      state.editingCampaignId = null;
      closeModal();
      await loadData();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  function openEditCampaign(campaign) {
    state.editingCampaignId = campaign.id;
    const modal = $('#campaignModal');
    modal.querySelector('.eyebrow').textContent = 'EDITAR CAMPANHA';
    modal.querySelector('#campaignModalTitle').textContent = 'Editar campanha';
    modal.querySelector('button[type="submit"]').textContent = 'Salvar alterações';
    const f = $('#campaignForm');
    f.reset();
    f.name.value = campaign.name || '';
    f.objective.value = campaign.objective || '';
    f.messageText.value = campaign.message_text || '';
    f.linkUrl.value = campaign.link_url || '';
    f.dispatchMode.value = campaign.dispatch_mode || 'standard';
    updateDispatchModeUI(campaign.dispatch_mode === 'single');
    f.minIntervalHours.value = campaign.min_interval_hours ?? 168;
    f.maxNotificationsPer30d.value = campaign.max_notifications_per_30d ?? 4;
    f.includeConverted.checked = campaign.include_converted ?? true;
    const rules = campaign.audience_rules_json || {};
    f.audienceStages.value = (rules.stages || []).join(', ');
    f.audienceOrigins.value = (rules.origins || []).join(', ');
    f.audienceTags.value = (rules.tagsAny || []).join(', ');
    // pre-fill asset if exists
    const asset = campaign.assets?.[0];
    if (asset) {
      $('#assetUrl').value = asset.url || '';
      $('#assetType').value = asset.asset_type || asset.type || '';
      $('#assetPlaceholder').classList.add('is-hidden');
      $('#assetPreview').classList.remove('is-hidden');
      $('#assetThumb').src = asset.url || '';
      $('#assetFileName').textContent = asset.url?.split('/').pop() || 'arquivo';
    }
    $('#modalBackdrop').classList.remove('is-hidden');
    modal.classList.add('is-active');
  }

  async function approveCampaign(campaignId, campaignName) {
    if (!confirm(`Aprovar campanha "${campaignName}"?\n\nIsso vai enfileirar os destinatários elegíveis para envio pelo n8n. Esta ação não pode ser desfeita sem cancelar a campanha.`)) return;
    try {
      const result = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/approve`, { method: 'POST' });
      await loadData();
      toast(`Campanha aprovada — ${result.queued} destinatário${result.queued !== 1 ? 's' : ''} na fila.`);
      closeModal();
    } catch (err) {
      toast(`Erro ao aprovar: ${err.message}`, 'error');
    }
  }

  async function cancelCampaign(campaignId, campaignName) {
    if (!confirm(`Cancelar campanha "${campaignName}"?\n\nTodos os envios pendentes serão cancelados.`)) return;
    try {
      const result = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/cancel`, { method: 'POST' });
      await loadData();
      toast(`Campanha cancelada — ${result.cancelled} destinatário${result.cancelled !== 1 ? 's' : ''} removido${result.cancelled !== 1 ? 's' : ''} da fila.`);
      closeModal();
    } catch (err) {
      toast(`Erro ao cancelar: ${err.message}`, 'error');
    }
  }

  async function cloneCampaign(campaignId, campaignName) {
    try {
      const result = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/clone`, { method: 'POST' });
      await loadData();
      toast(`Campanha "${result.name || campaignName + ' (cópia)'}" criada como rascunho.`);
    } catch (err) {
      toast(`Erro ao clonar: ${err.message}`, 'error');
    }
  }

  async function runPreflight(campaignId, campaignName) {
    $('#preflightModalTitle').textContent = campaignName;
    $('#preflightContent').innerHTML = '<p class="list-placeholder" style="padding:32px">Calculando elegibilidade…</p>';
    $('#modalBackdrop').classList.remove('is-hidden');
    $('#preflightModal').classList.add('is-active');
    try {
      const report = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/preflight`, { method: 'POST' });
      $('#preflightContent').innerHTML = buildPreflightHtml(report);
      bindApproveButton(campaignId, campaignName);
      await loadData();
    } catch (err) {
      $('#preflightContent').innerHTML = `<p class="form-error" style="padding:16px">${escapeHtml(err.message)}</p>`;
    }
  }

  function bindApproveButton(campaignId, campaignName) {
    const btn = $('#approveFromPreflightBtn');
    if (!btn) return;
    btn.onclick = () => approveCampaign(campaignId, campaignName);
  }

  function buildPreflightHtml(report) {
    const money_m = (cents) => cents == null ? '—' : money(cents);
    const bandRow = (data, label) => `
      <tr>
        <td>${label}</td><td>${data.contacts}</td>
        <td>${data.converted}</td>
        <td>${money_m(data.revenue_cents)}</td>
      </tr>`;
    const excludedRows = Object.entries(report.excluded_by_reason || {})
      .map(([k, v]) => `<tr><td>${escapeHtml(exclusionLabels[k] || k)}</td><td>${v}</td></tr>`)
      .join('') || '<tr><td colspan="2" class="muted" style="padding:12px 18px">Nenhuma exclusão</td></tr>';
    const recipientRows = (report.recipients || []).map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.full_name)}</strong></td>
        <td>${escapeHtml(r.phone_e164 || '—')}</td>
        <td>${escapeHtml(stageLabels[r.stage] || r.stage)}</td>
        <td>${r.eligible ? '<span class="permission ok">● Elegível</span>' : '<span class="permission blocked">● Excluído</span>'}</td>
        <td style="font-size:10px;color:var(--muted)">${(r.exclusion_reasons || []).map((k) => escapeHtml(exclusionLabels[k] || k)).join(', ') || '—'}</td>
      </tr>`).join('');
    const b = report.exposure_bands || {};
    return `
      <div class="preflight-metrics">
        <div class="metric-card"><div class="metric-head"><span>AVALIADOS</span></div><strong>${report.totals.evaluated}</strong><p>contatos na base</p></div>
        <div class="metric-card accent"><div class="metric-head"><span>ELEGÍVEIS</span></div><strong>${report.totals.eligible}</strong><p>receberão a campanha</p></div>
        <div class="metric-card"><div class="metric-head"><span>EXCLUÍDOS</span></div><strong>${report.totals.excluded}</strong><p>por algum critério</p></div>
      </div>
      ${report.conversion_data === 'not_configured' ? '<p class="preflight-note">Dados de conversão indisponíveis — sem integração ativa com o SamJoE Food. A coluna "Convertidos" mostrará zero.</p>' : ''}
      <div class="preflight-grid" style="margin-top:18px">
        <div>
          <p class="eyebrow" style="margin:0 0 8px">MOTIVOS DE EXCLUSÃO</p>
          <div class="table-panel"><table style="min-width:0"><thead><tr><th>Motivo</th><th>Qtd</th></tr></thead><tbody>${excludedRows}</tbody></table></div>
        </div>
        <div>
          <p class="eyebrow" style="margin:0 0 8px">EXPOSIÇÃO PRÉVIA (elegíveis)</p>
          <div class="table-panel"><table style="min-width:0">
            <thead><tr><th>Faixa</th><th>Contatos</th><th>Conv.</th><th>Receita</th></tr></thead>
            <tbody>
              ${b.never_received?.contacts ? bandRow(b.never_received, 'Nunca receberam') : ''}
              ${b.received_once?.contacts ? bandRow(b.received_once, 'Receberam 1×') : ''}
              ${b.received_twice?.contacts ? bandRow(b.received_twice, 'Receberam 2×') : ''}
              ${b.received_more_than_twice?.contacts ? bandRow(b.received_more_than_twice, 'Receberam 3×+') : ''}
              ${b.received_more_than_twice_without_conversion?.contacts ? bandRow(b.received_more_than_twice_without_conversion, '3×+ sem conversão') : ''}
            </tbody>
          </table></div>
        </div>
      </div>
      ${recipientRows ? `
        <p class="eyebrow" style="margin:18px 0 8px">LISTA NOMINAL (${(report.recipients || []).length} contatos)</p>
        <div class="table-panel"><div class="table-wrap"><table>
          <thead><tr><th>Nome</th><th>Telefone</th><th>Etapa</th><th>Status</th><th>Motivos de exclusão</th></tr></thead>
          <tbody>${recipientRows}</tbody>
        </table></div></div>
      ` : ''}
      <p class="muted" style="font-size:10px;margin-top:12px">Gerado em ${new Date(report.snapshot_created_at).toLocaleString('pt-BR')} · hash ${(report.snapshot_hash || '').slice(0, 12)}…</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
        <p style="flex:1;font-size:11px;color:var(--muted);margin:0;align-self:center">Somente owner ou manager podem aprovar. O envio real requer n8n + Evolution configurados.</p>
        <button class="primary-button" id="approveFromPreflightBtn" style="background:var(--green)">Aprovar e enfileirar →</button>
      </div>
    `;
  }

  async function submitConsent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const purposes = Array.from(form.querySelectorAll('[name="purposes"]:checked')).map((el) => el.value);
    if (!purposes.length) {
      error.textContent = 'Selecione ao menos uma finalidade.';
      return;
    }
    const payload = {
      channel: 'whatsapp', purposes, action: values.action,
      source: values.source, policyVersion: '1.0', occurredAt: new Date().toISOString(),
    };
    setButtonLoading(submit, true, 'Registrando...');
    try {
      await api(`/api/v1/contacts/${encodeURIComponent(values.contactId)}/consents`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadData();
      toast(values.action === 'granted' ? 'Autorização registrada.' : 'Revogação registrada.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  function populateStages() {
    const options = Object.entries(stageLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    $('#stageFilter').insertAdjacentHTML('beforeend', options);
    $('#contactStage').innerHTML = options;
  }

  function fmtBRL(cents) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  }

  function fmtPct(num, den) {
    if (!den) return '—';
    return Math.round((num / den) * 100) + '%';
  }

  function funnelBar(val, total) {
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    return `<span class="funnel-bar"><span class="funnel-bar-track"><span class="funnel-bar-fill" style="width:${pct}%"></span></span>${val.toLocaleString('pt-BR')}</span>`;
  }

  async function loadAnalytics() {
    try {
      const result = await api('/api/v1/analytics/campaigns');
      renderAnalytics(result);
    } catch {
      $('#analyticsTableBody').innerHTML = '<tr><td colspan="9" class="empty-state">Não foi possível carregar os resultados.</td></tr>';
    }
  }

  function renderAnalytics({ campaigns, summary }) {
    $('#statCampaigns').textContent = summary.total_campaigns.toLocaleString('pt-BR');
    $('#statReach').textContent = summary.total_recipients.toLocaleString('pt-BR');
    $('#statEngagement').textContent = summary.engagement_rate + '%';
    $('#statConversions').textContent = summary.total_conversions.toLocaleString('pt-BR');
    $('#statRevenue').textContent = fmtBRL(summary.total_revenue_cents);

    const tbody = $('#analyticsTableBody');
    if (!campaigns.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Nenhuma campanha ainda. Crie uma na view de Campanhas.</td></tr>';
      return;
    }
    tbody.innerHTML = campaigns.map(c => {
      const engagedOfRecip = fmtPct(c.engaged, c.recipients);
      const readOfEngaged = c.engaged > 0 ? Math.round((c.read / c.engaged) * 100) + '%' : '—';
      return `<tr data-campaign-id="${c.id}">
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td><span class="status-badge ${campaignStatusClass[c.status] ?? 'neutral'}">${escapeHtml(campaignStatusLabels[c.status] ?? c.status)}</span></td>
        <td>${c.recipients.toLocaleString('pt-BR')}</td>
        <td class="col-num">${funnelBar(c.engaged, c.recipients)}</td>
        <td class="col-num">${funnelBar(c.read, c.recipients)}</td>
        <td class="col-num">${readOfEngaged}</td>
        <td class="col-num">${c.conversions > 0 ? '<strong>' + c.conversions + '</strong>' : '—'}</td>
        <td class="col-num">${c.revenue_cents > 0 ? fmtBRL(c.revenue_cents) : '—'}</td>
        <td class="col-num">${c.margin_cents > 0 ? fmtBRL(c.margin_cents) : '—'}</td>
      </tr>`;
    }).join('');
  }

  function resetAssetUpload() {
    $('#assetFileInput').value = '';
    $('#assetUrl').value = '';
    $('#assetType').value = '';
    $('#assetPlaceholder').classList.remove('is-hidden');
    $('#assetPreview').classList.add('is-hidden');
    $('#assetThumb').src = '';
    $('#assetHint').classList.add('is-hidden');
    $('#assetUploadArea').classList.remove('is-uploading', 'has-asset');
  }

  async function handleAssetFileChange() {
    const file = $('#assetFileInput').files[0];
    if (!file) return;
    const area = $('#assetUploadArea');
    area.classList.add('is-uploading');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/v1/uploads/media', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
        body: fd,
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error?.message || 'Erro no upload');
      const { url, assetType } = result.data;
      $('#assetUrl').value = url;
      $('#assetType').value = assetType;
      $('#assetFileName').textContent = file.name;
      if (assetType === 'image') {
        $('#assetThumb').src = url;
        $('#assetThumb').classList.remove('is-hidden');
      } else {
        $('#assetThumb').src = '';
        $('#assetThumb').classList.add('is-hidden');
        $('#assetFileName').textContent = `🎬 ${file.name}`;
      }
      $('#assetPlaceholder').classList.add('is-hidden');
      $('#assetPreview').classList.remove('is-hidden');
      $('#assetHint').classList.remove('is-hidden');
      area.classList.add('has-asset');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      area.classList.remove('is-uploading');
    }
  }

  async function loadSettings() {
    try {
      const result = await api('/api/v1/settings');
      const s = result.data;
      if (!s) return;
      $('#settingsTenantName').value = s.tenantName ?? '';
      $('#settingsAppUrl').value = s.appUrl ?? '';
      $('#varAppUrlPreview').textContent = s.appUrl || '—';
    } catch {
      $('#settingsError').textContent = 'Não foi possível carregar as configurações.';
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('#settingsSaveBtn');
    const error = $('#settingsError');
    error.textContent = '';
    setButtonLoading(submit, true);
    try {
      const result = await api('/api/v1/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          tenantName: form.tenantName.value.trim(),
          appUrl: form.appUrl.value.trim(),
        }),
      });
      const s = result.data;
      $('#varAppUrlPreview').textContent = s.appUrl || '—';
      toast('Configurações salvas.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function loadSamJoeFoodConfig() {
    try {
      const result = await api('/api/v1/integrations/samjoe-food');
      const cfg = result.data;
      const badge = $('#samjoeFoodBadge');
      const lastEvent = $('#samjoeFoodLastEvent');
      const dot = $('#samjoeFoodHealthDot');
      if (!cfg) {
        badge.textContent = 'Não configurado';
        badge.className = 'status-badge neutral';
        lastEvent.classList.add('is-hidden');
        if (dot) dot.className = 'health-dot';
      } else if (cfg.status === 'active') {
        badge.textContent = 'Ativo';
        badge.className = 'status-badge success';
        if (dot) dot.className = 'health-dot ok';
        if (cfg.last_event_at) {
          lastEvent.textContent = `Último evento: ${new Date(cfg.last_event_at).toLocaleString('pt-BR')}`;
          lastEvent.classList.remove('is-hidden');
        } else {
          lastEvent.classList.add('is-hidden');
        }
      } else {
        badge.textContent = 'Desativado';
        badge.className = 'status-badge warning';
        if (dot) dot.className = 'health-dot warn';
        lastEvent.classList.add('is-hidden');
      }
    } catch {
      // integration not configured yet — ignore 404
    }
  }

  // ─── WhatsApp QR Code flow ────────────────────────────────────────────────
  let waStatusPollTimer = null;

  function waShowStep(step) {
    ['waStepLoading', 'waStepQr', 'waStepConnected', 'waStepError'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.classList.toggle('is-hidden', id !== step);
    });
  }

  async function openWaModal() {
    $('#waModal').classList.add('is-active');
    $('#waModalBackdrop').classList.remove('is-hidden');
    // Load saved advanced config
    try {
      const cfg = await api('/api/v1/integrations/whatsapp/config');
      if (cfg.data) {
        $('#waApiUrlInput').value = cfg.data.evolutionUrl || 'http://localhost:8081';
        $('#waInstanceInput').value = cfg.data.instanceName || 'samjoe';
        $('#waApiUrlInputErr').value = cfg.data.evolutionUrl || 'http://localhost:8081';
        $('#waInstanceInputErr').value = cfg.data.instanceName || 'samjoe';
      }
    } catch { /* ignore */ }
    waShowStep('waStepLoading');
    await waLoadQr();
  }

  function closeWaModal() {
    $('#waModal').classList.remove('is-active');
    $('#waModalBackdrop').classList.add('is-hidden');
    if (waStatusPollTimer) { clearInterval(waStatusPollTimer); waStatusPollTimer = null; }
    checkWaHealth();
  }

  async function waLoadQr() {
    try {
      const result = await api('/api/v1/integrations/whatsapp/qr');
      const { base64, code } = result.data;
      if (base64) {
        $('#waQrImage').src = base64;
      } else if (code) {
        // Fallback: render code as text (rare)
        $('#waQrImage').alt = code;
      } else {
        waShowStep('waStepError');
        $('#waError').textContent = 'QR code não disponível. A instância pode já estar conectada.';
        await waCheckIfAlreadyConnected();
        return;
      }
      waShowStep('waStepQr');
      $('#waQrHint').textContent = 'Aguardando leitura…';
      waStartStatusPolling();
    } catch (err) {
      waShowStep('waStepError');
      $('#waError').textContent = err.message || 'Não foi possível obter o QR code.';
    }
  }

  function waStartStatusPolling() {
    if (waStatusPollTimer) clearInterval(waStatusPollTimer);
    waStatusPollTimer = setInterval(async () => {
      try {
        const result = await api('/api/v1/integrations/whatsapp/status');
        const state = result.data?.state;
        if (state === 'open') {
          clearInterval(waStatusPollTimer);
          waStatusPollTimer = null;
          waShowStep('waStepConnected');
          checkWaHealth();
        }
      } catch { /* keep polling */ }
    }, 3000);
  }

  async function waCheckIfAlreadyConnected() {
    try {
      const result = await api('/api/v1/integrations/whatsapp/status');
      if (result.data?.state === 'open') {
        waShowStep('waStepConnected');
      }
    } catch { /* ignore */ }
  }

  async function saveWaConfig() {
    const url = $('#waApiUrlInput')?.value.trim() || 'http://localhost:8081';
    const instance = $('#waInstanceInput')?.value.trim() || 'samjoe';
    try {
      await api('/api/v1/integrations/whatsapp/config', {
        method: 'PUT',
        body: JSON.stringify({ evolutionUrl: url, instanceName: instance }),
      });
      if (waStatusPollTimer) { clearInterval(waStatusPollTimer); waStatusPollTimer = null; }
      waShowStep('waStepLoading');
      await waLoadQr();
    } catch (err) {
      toast('Erro ao salvar: ' + err.message, 'error');
    }
  }

  async function saveWaConfigFromError() {
    const url = $('#waApiUrlInputErr')?.value.trim() || 'http://localhost:8081';
    const instance = $('#waInstanceInputErr')?.value.trim() || 'samjoe';
    // Sync values to advanced panel too
    if ($('#waApiUrlInput')) $('#waApiUrlInput').value = url;
    if ($('#waInstanceInput')) $('#waInstanceInput').value = instance;
    try {
      await api('/api/v1/integrations/whatsapp/config', {
        method: 'PUT',
        body: JSON.stringify({ evolutionUrl: url, instanceName: instance }),
      });
      waShowStep('waStepLoading');
      await waLoadQr();
    } catch (err) {
      toast('Erro ao salvar: ' + err.message, 'error');
    }
  }

  async function disconnectWhatsApp() {
    if (!confirm('Desconectar o WhatsApp desta instância?')) return;
    try {
      await api('/api/v1/integrations/whatsapp/disconnect', { method: 'DELETE' });
      toast('WhatsApp desconectado.');
      checkWaHealth();
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
    }
  }

  function openN8nModal() {
    $('#n8nApiUrlInput').value = localStorage.getItem('n8nApiUrl') || '';
    $('#n8nModal').classList.add('is-active');
    $('#n8nModalBackdrop').classList.remove('is-hidden');
  }
  function closeN8nModal() {
    $('#n8nModal').classList.remove('is-active');
    $('#n8nModalBackdrop').classList.add('is-hidden');
  }
  async function saveN8nConfig() {
    const url = $('#n8nApiUrlInput').value.trim() || 'http://localhost:5679';
    localStorage.setItem('n8nApiUrl', url);
    closeN8nModal();
    toast('Configuração de automações salva.');
    checkN8nHealth();
  }

  function openSamJoeFoodModal() {
    $('#samjoeFoodModalBackdrop').classList.remove('is-hidden');
    $('#samjoeFoodForm').reset();
    $('[data-form-error]', $('#samjoeFoodForm')).textContent = '';
  }

  function closeSamJoeFoodModal() {
    $('#samjoeFoodModalBackdrop').classList.add('is-hidden');
  }

  async function submitSamJoeFoodForm(event) {
    event.preventDefault();
    const form = $('#samjoeFoodForm');
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const fd = new FormData(form);
    const payload = { status: fd.get('status') };
    const secret = fd.get('hmacSecret')?.trim();
    if (secret) payload.hmacSecret = secret;
    try {
      await api('/api/v1/integrations/samjoe-food', { method: 'PUT', body: JSON.stringify(payload) });
      closeSamJoeFoodModal();
      await loadSamJoeFoodConfig();
      toast('Integração SamJoE Food salva.');
    } catch (err) {
      error.textContent = err.message;
    }
  }

  // ─── SamJoE Food auto-detect & wizard ────────────────────────────────────

  async function detectSamJoeFood() {
    const candidates = ['http://localhost:3000', 'http://localhost:3001'];
    for (const url of candidates) {
      try {
        const result = await api('/api/v1/integrations/samjoe-food/detect', {
          method: 'POST',
          body: JSON.stringify({ foodAppUrl: url }),
        });
        if (result.data?.reachable) {
          const banner = $('#samjoeFoodDetectBanner');
          const urlLabel = $('#samjoeFoodDetectedUrl');
          if (banner && urlLabel) {
            urlLabel.textContent = url;
            banner.classList.remove('is-hidden');
            $('#foodAppUrlInput').value = url;
          }
          return;
        }
      } catch { /* ignore */ }
    }
  }

  function openFoodConnectModal() {
    $('#foodConnectStepForm').classList.remove('is-hidden');
    $('#foodConnectStepSuccess').classList.add('is-hidden');
    $('#foodConnectError').classList.add('is-hidden');
    $('#foodConnectModalBackdrop').classList.remove('is-hidden');
  }

  function closeFoodConnectModal() {
    $('#foodConnectModalBackdrop').classList.add('is-hidden');
  }

  async function doFoodConnect() {
    const btn = $('#doFoodConnectBtn');
    const error = $('#foodConnectError');
    const urlInput = $('#foodAppUrlInput');
    const foodAppUrl = urlInput.value.trim() || 'http://localhost:3000';
    error.classList.add('is-hidden');
    setButtonLoading(btn, true, 'Conectando…');
    try {
      const result = await api('/api/v1/integrations/samjoe-food/auto-connect', {
        method: 'POST',
        body: JSON.stringify({ foodAppUrl }),
      });
      const { autoConfigured, webhookUrl, hmacSecret, autoConfigError } = result.data;
      $('#foodConnectStepForm').classList.add('is-hidden');
      $('#foodConnectStepSuccess').classList.remove('is-hidden');
      if (autoConfigured) {
        $('#foodConnectSuccessNote').textContent = 'A loja foi configurada automaticamente. Pedidos serão recebidos em tempo real.';
        $('#foodConnectManualConfig').classList.add('is-hidden');
      } else {
        $('#foodConnectSuccessNote').textContent = (autoConfigError ? `Configuração manual necessária (${autoConfigError}).` : 'Configure o webhook manualmente na loja.');
        $('#foodWebhookUrlDisplay').value = webhookUrl;
        $('#foodHmacDisplay').value = hmacSecret;
        $('#foodConnectManualConfig').classList.remove('is-hidden');
      }
      await loadSamJoeFoodConfig();
      $('#samjoeFoodDetectBanner')?.classList.add('is-hidden');
      toast('SamJoE Food configurado com sucesso!');
    } catch (err) {
      error.textContent = err.message || 'Erro ao conectar.';
      error.classList.remove('is-hidden');
    } finally {
      setButtonLoading(btn, false, 'Conectar');
    }
  }

  function updateDispatchModeUI(isSingle) {
    const freqFields = $('#campaignFreqFields');
    const hint = $('#dispatchModeHint');
    if (freqFields) freqFields.style.display = isSingle ? 'none' : '';
    if (hint) hint.classList.toggle('is-hidden', !isSingle);
  }

  // ─── Públicos / Analytics ─────────────────────────────────────────────────

  async function loadPublicos() {
    await Promise.all([
      loadProductAnalytics(),
      loadFrequencyAnalytics(),
      loadEngagementAnalytics(),
      loadAudiences(),
    ]).catch(() => {});
  }

  async function loadProductAnalytics() {
    const days = $('#productPeriod')?.value || 90;
    try {
      const result = await api(`/api/v1/analytics/products?days=${days}`);
      renderProductAnalytics(result.products || []);
    } catch {
      $('#productAnalyticsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Sem dados de itens de pedido. Configure a integração SamJoE Food e envie pedidos com items[].</td></tr>';
    }
  }

  function renderProductAnalytics(products) {
    const tbody = $('#productAnalyticsBody');
    if (!products.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum item de pedido registrado ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = products.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.product_name)}</strong>${p.external_product_id ? `<br><small class="muted">${escapeHtml(p.external_product_id)}</small>` : ''}</td>
        <td>${escapeHtml(p.category || '—')}</td>
        <td style="text-align:right">${p.orders.toLocaleString('pt-BR')}</td>
        <td style="text-align:right">${p.unique_buyers.toLocaleString('pt-BR')}</td>
        <td style="text-align:right">${p.units_sold.toLocaleString('pt-BR')}</td>
        <td style="text-align:right">${money(p.revenue_cents)}</td>
      </tr>`).join('');
  }

  async function loadFrequencyAnalytics() {
    try {
      const result = await api('/api/v1/analytics/frequency');
      renderFrequencyAnalytics(result);
    } catch {
      $('#freqBuckets').innerHTML = '<p class="list-placeholder">Dados indisponíveis.</p>';
    }
  }

  function renderFrequencyAnalytics({ buckets = [], total_buyers = 0, never_purchased = 0 }) {
    const total = total_buyers + never_purchased || 1;
    const rows = [
      ...buckets.map((b) => ({ label: b.label, count: b.contact_count, pct: Math.round((b.contact_count / total) * 100) })),
      { label: 'Nunca comprou', count: never_purchased, pct: Math.round((never_purchased / total) * 100) },
    ];
    $('#freqBuckets').innerHTML = rows.map((r) => `
      <div class="freq-row">
        <span class="freq-label">${escapeHtml(r.label)}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${r.pct}%"></div></div>
        <span class="freq-count">${r.count.toLocaleString('pt-BR')} <small>${r.pct}%</small></span>
      </div>`).join('') || '<p class="list-placeholder">Nenhuma compra registrada.</p>';
  }

  async function loadEngagementAnalytics() {
    try {
      const result = await api('/api/v1/analytics/engagement');
      renderEngagementAnalytics(result.segments || []);
    } catch {
      $('#engagementSegments').innerHTML = '<p class="list-placeholder">Dados indisponíveis.</p>';
    }
  }

  function renderEngagementAnalytics(segments) {
    $('#engagementSegments').innerHTML = segments.map((s) => `
      <div class="engagement-row">
        <div><strong>${escapeHtml(s.label)}</strong><small>${escapeHtml(s.description)}</small></div>
        <span class="freq-count">${s.contact_count.toLocaleString('pt-BR')}</span>
      </div>`).join('') || '<p class="list-placeholder">Nenhuma campanha disparada ainda.</p>';
  }

  // ─── Audiences ────────────────────────────────────────────────────────────

  async function loadAudiences() {
    try {
      const result = await api('/api/v1/audiences');
      state.audiences = result.data || [];
      renderAudiences();
    } catch {
      $('#audiencesList').innerHTML = '<p class="list-placeholder" style="padding:24px">Erro ao carregar públicos.</p>';
    }
  }

  function renderAudiences() {
    const list = $('#audiencesList');
    if (!state.audiences.length) {
      list.innerHTML = `
        <div class="empty-state" style="padding:40px 20px">
          <span>⊡</span>
          <h3>Nenhum público criado</h3>
          <p>Crie segmentos com regras combinadas para usar em campanhas específicas.</p>
        </div>`;
      return;
    }
    list.innerHTML = state.audiences.map((a) => `
      <div class="audience-card">
        <div class="audience-card-head">
          <div>
            <strong>${escapeHtml(a.name)}</strong>
            ${a.description ? `<p class="muted" style="font-size:12px;margin:2px 0 0">${escapeHtml(a.description)}</p>` : ''}
          </div>
          <div class="audience-card-meta">
            ${a.contact_count != null ? `<span class="audience-count">${a.contact_count.toLocaleString('pt-BR')} contatos</span>` : '<span class="muted" style="font-size:11px">Não avaliado</span>'}
            ${a.last_evaluated_at ? `<small class="muted">${relativeDate(a.last_evaluated_at)}</small>` : ''}
          </div>
        </div>
        <div class="audience-card-actions">
          <button class="row-action" data-evaluate-audience="${a.id}">↻ Avaliar</button>
          <button class="row-action" data-edit-audience="${a.id}">Editar</button>
          <button class="row-action cancel" data-delete-audience="${a.id}" data-delete-name="${escapeHtml(a.name)}">Excluir</button>
        </div>
      </div>`).join('');
  }

  function openAudienceModal(audience = null) {
    state.editingAudienceId = audience?.id ?? null;
    const modal = $('#audienceModal');
    const form = $('#audienceForm');
    form.reset();
    $('[data-form-error]', form).textContent = '';
    $('#audienceEvalResult').classList.add('is-hidden');
    $('#audienceEvalResult').innerHTML = '';
    const isEdit = Boolean(audience);
    $('#audienceModalEyebrow').textContent = isEdit ? 'EDITAR PÚBLICO' : 'NOVO PÚBLICO';
    $('#audienceModalTitle').textContent = isEdit ? 'Editar público' : 'Criar público';
    $('#saveAudienceBtn').textContent = isEdit ? 'Salvar alterações' : 'Criar público';
    $('#evaluateAudienceBtn').style.display = isEdit ? '' : 'none';
    if (audience) {
      form.name.value = audience.name || '';
      form.description.value = audience.description || '';
      const r = audience.rules || {};
      form.ruleStages.value = (r.stages || []).join(', ');
      form.ruleOrigins.value = (r.origins || []).join(', ');
      form.ruleTags.value = (r.tags || []).join(', ');
      form.ruleProductIds.value = (r.purchasedProductIds || []).join(', ');
      form.ruleFreqMin.value = r.purchaseFrequency?.min ?? '';
      form.ruleFreqDays.value = r.purchaseFrequency?.days ?? '';
      form.ruleLastPurchaseDays.value = r.lastPurchaseDays ?? '';
      form.ruleLapsedDays.value = r.lapsedDays ?? '';
      form.ruleCampaignEngagedDays.value = r.campaignEngagedDays ?? '';
      form.ruleNotEngagedDays.value = r.notEngagedDays ?? '';
    }
    renderProductPicker();
    modal.classList.add('is-active');
    $('#modalBackdrop').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
  }

  function renderProductPicker() {
    const picker = $('#audienceProductPicker');
    if (!state.products.length) { picker.innerHTML = ''; return; }
    picker.innerHTML = `
      <p class="eyebrow" style="margin:14px 0 6px;font-size:10px">PRODUTOS DO CATÁLOGO</p>
      <div class="product-tag-list">
        ${state.products.map((p) => `
          <label class="product-tag-item">
            <input type="checkbox" class="product-tag-cb" value="${p.id}" data-sku="${escapeHtml(p.sku)}" />
            <span>${escapeHtml(p.name)}</span>
          </label>`).join('')}
      </div>
      <small class="muted">Marque produtos para preencher o campo acima automaticamente.</small>`;
    $$('.product-tag-cb', picker).forEach((cb) => {
      cb.addEventListener('change', () => {
        const checked = $$('.product-tag-cb:checked', picker).map((el) => el.value);
        $('#ruleProductIds').value = checked.join(', ');
      });
    });
  }

  function buildAudienceRulesFromForm(form) {
    const split = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
    const rules = {};
    const stages = split(form.ruleStages.value); if (stages.length) rules.stages = stages;
    const origins = split(form.ruleOrigins.value); if (origins.length) rules.origins = origins;
    const tags = split(form.ruleTags.value); if (tags.length) rules.tags = tags;
    const productIds = split(form.ruleProductIds.value); if (productIds.length) rules.purchasedProductIds = productIds;
    const freqMin = Number(form.ruleFreqMin.value);
    const freqDays = Number(form.ruleFreqDays.value);
    if (freqMin > 0 && freqDays > 0) rules.purchaseFrequency = { min: freqMin, days: freqDays };
    const lastPurchase = Number(form.ruleLastPurchaseDays.value); if (lastPurchase > 0) rules.lastPurchaseDays = lastPurchase;
    const lapsed = Number(form.ruleLapsedDays.value); if (lapsed > 0) rules.lapsedDays = lapsed;
    const engaged = Number(form.ruleCampaignEngagedDays.value); if (engaged > 0) rules.campaignEngagedDays = engaged;
    const notEngaged = Number(form.ruleNotEngagedDays.value); if (notEngaged > 0) rules.notEngagedDays = notEngaged;
    return rules;
  }

  async function submitAudience(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('#saveAudienceBtn');
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const payload = {
      name: form.name.value.trim(),
      description: form.description.value.trim() || undefined,
      rules: buildAudienceRulesFromForm(form),
    };
    setButtonLoading(submit, true);
    try {
      if (state.editingAudienceId) {
        await api(`/api/v1/audiences/${encodeURIComponent(state.editingAudienceId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Público atualizado.');
      } else {
        await api('/api/v1/audiences', { method: 'POST', body: JSON.stringify(payload) });
        toast('Público criado com sucesso.');
      }
      closeAudienceModal();
      await loadAudiences();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function evaluateAudienceFromModal() {
    const btn = $('#evaluateAudienceBtn');
    if (!state.editingAudienceId) return;
    setButtonLoading(btn, true, 'Avaliando…');
    try {
      const result = await api(`/api/v1/audiences/${encodeURIComponent(state.editingAudienceId)}/evaluate`, { method: 'POST' });
      const el = $('#audienceEvalResult');
      el.classList.remove('is-hidden');
      const sample = (result.contacts || []).slice(0, 5).map((c) => escapeHtml(c.full_name)).join(', ');
      el.innerHTML = `<strong>${result.contact_count.toLocaleString('pt-BR')} contatos elegíveis</strong>${sample ? `<small> — ${sample}${result.contact_count > 5 ? '…' : ''}</small>` : ''}`;
      await loadAudiences();
    } catch (err) {
      toast(`Erro ao avaliar: ${err.message}`, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  }

  function closeAudienceModal() {
    state.editingAudienceId = null;
    $('#audienceModal').classList.remove('is-active');
    $('#modalBackdrop').classList.add('is-hidden');
    $$('.modal').forEach((node) => node.classList.remove('is-active'));
    document.body.style.overflow = '';
  }

  function bindEvents() {
    $('#loginForm').addEventListener('submit', login);
    $('#logoutButton').addEventListener('click', () => logout());
    $('#refreshButton').addEventListener('click', () => loadData(true));
    $('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
    $('#togglePassword').addEventListener('click', () => {
      const input = $('#passwordInput');
      input.type = input.type === 'password' ? 'text' : 'password';
      $('#togglePassword').setAttribute('aria-label', input.type === 'password' ? 'Mostrar senha' : 'Ocultar senha');
    });
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
    $$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
    $$('[data-open]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.open)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', closeModal));
    $('#modalBackdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
    $('#contactSearch').addEventListener('input', renderContacts);
    $('#stageFilter').addEventListener('change', renderContacts);
    $('#productSearch').addEventListener('input', renderProducts);
    $('#campaignDateFrom').addEventListener('change', renderCampaigns);
    $('#campaignDateTo').addEventListener('change', renderCampaigns);
    $('#campaignDateClear').addEventListener('click', () => {
      $('#campaignDateFrom').value = '';
      $('#campaignDateTo').value = '';
      $$('.filter-chip').forEach((el) => el.classList.remove('is-active'));
      renderCampaigns();
    });
    $('#campaignFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      chip.classList.toggle('is-active');
      renderCampaigns();
    });
    $('#queueStatusFilter').addEventListener('change', () => {
      state.queue.status = $('#queueStatusFilter').value;
      state.queue.offset = 0;
      loadQueue().catch(() => {});
    });
    $('#queueCampaignFilter').addEventListener('change', () => {
      state.queue.campaignId = $('#queueCampaignFilter').value;
      state.queue.offset = 0;
      loadQueue().catch(() => {});
    });
    $('#queueRefreshBtn').addEventListener('click', () => loadQueue().catch(() => {}));
    $('#contactsTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-consent-id]');
      if (button) openModal('consent', { id: button.dataset.consentId, name: button.dataset.consentName });
    });
    $('#campaignsTableBody').addEventListener('click', (event) => {
      const pf = event.target.closest('[data-preflight-id]');
      if (pf) return runPreflight(pf.dataset.preflightId, pf.dataset.preflightName);
      const ap = event.target.closest('[data-approve-id]');
      if (ap) return approveCampaign(ap.dataset.approveId, ap.dataset.approveName);
      const ca = event.target.closest('[data-cancel-id]');
      if (ca) return cancelCampaign(ca.dataset.cancelId, ca.dataset.cancelName);
      const cl = event.target.closest('[data-clone-id]');
      if (cl) return cloneCampaign(cl.dataset.cloneId, cl.dataset.cloneName);
      const vc = event.target.closest('[data-view-campaign-id]');
      if (vc) {
        const cid = vc.dataset.viewCampaignId;
        switchView('results');
        loadAnalytics().then(() => {
          const row = $(`[data-campaign-id="${cid}"]`);
          if (row) {
            row.classList.add('campaign-highlight');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.addEventListener('animationend', () => row.classList.remove('campaign-highlight'), { once: true });
          }
        }).catch(() => {});
        return;
      }
      const ed = event.target.closest('[data-edit-id]');
      if (ed) {
        const campaign = state.campaigns.find((c) => c.id === ed.dataset.editId);
        if (campaign) openEditCampaign(campaign);
      }
    });
    $('#contactForm').addEventListener('submit', submitContact);
    $('#productForm').addEventListener('submit', submitProduct);
    $('#consentForm').addEventListener('submit', submitConsent);
    $('#campaignForm').addEventListener('submit', submitCampaign);
    $('#assetUploadArea').addEventListener('click', (e) => {
      if (e.target.closest('#assetRemoveBtn')) return;
      $('#assetFileInput').click();
    });
    $('#assetRemoveBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      resetAssetUpload();
    });
    $('#assetFileInput').addEventListener('change', handleAssetFileChange);
    $('#waConfigBtn').addEventListener('click', openWaModal);
    $('#waDisconnectBtn').addEventListener('click', disconnectWhatsApp);
    $$('[data-close-wa]').forEach((el) => el.addEventListener('click', closeWaModal));
    $('#waModalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWaModal(); });
    $('#saveWaConfigBtn').addEventListener('click', saveWaConfig);
    $('#waTryAgainBtn').addEventListener('click', saveWaConfigFromError);
    $('#waAdvancedToggle').addEventListener('click', () => {
      const adv = $('#waAdvancedConfig');
      adv.classList.toggle('is-hidden');
    });
    $('#n8nConfigBtn').addEventListener('click', openN8nModal);
    $$('[data-close-n8n]').forEach((el) => el.addEventListener('click', closeN8nModal));
    $('#n8nModalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeN8nModal(); });
    $('#saveN8nConfigBtn').addEventListener('click', saveN8nConfig);
    // SamJoE Food: "Configurar" opens the auto-connect wizard; advanced manual config via the existing modal is kept accessible
    $('#openSamJoeFoodModalBtn').addEventListener('click', openFoodConnectModal);
    $$('[data-close-samjoe-food]').forEach((el) => el.addEventListener('click', closeSamJoeFoodModal));
    $('#samjoeFoodModalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSamJoeFoodModal(); });
    $('#samjoeFoodForm').addEventListener('submit', submitSamJoeFoodForm);
    // SamJoE Food auto-connect wizard
    $('#samjoeFoodAutoConnectBtn').addEventListener('click', openFoodConnectModal);
    $('#closeFoodConnectModalBtn').addEventListener('click', closeFoodConnectModal);
    $('#cancelFoodConnectBtn').addEventListener('click', closeFoodConnectModal);
    $('#doFoodConnectBtn').addEventListener('click', doFoodConnect);
    $('#closeFoodConnectSuccessBtn').addEventListener('click', closeFoodConnectModal);
    $('#foodConnectModalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeFoodConnectModal(); });
    $('#copyWebhookUrlBtn').addEventListener('click', () => {
      navigator.clipboard.writeText($('#foodWebhookUrlDisplay').value).then(() => toast('URL copiada.'));
    });
    $('#copyHmacBtn').addEventListener('click', () => {
      navigator.clipboard.writeText($('#foodHmacDisplay').value).then(() => toast('Chave copiada.'));
    });
    $('#settingsForm').addEventListener('submit', saveSettings);

    // Dispatch mode toggle
    $('#dispatchModeSelect').addEventListener('change', (e) => updateDispatchModeUI(e.target.value === 'single'));

    // Públicos
    $('#newAudienceBtn').addEventListener('click', () => openAudienceModal());
    $('#closeAudienceModalBtn').addEventListener('click', closeAudienceModal);
    $('#cancelAudienceBtn').addEventListener('click', closeAudienceModal);
    $('#audienceForm').addEventListener('submit', submitAudience);
    $('#evaluateAudienceBtn').addEventListener('click', evaluateAudienceFromModal);
    $('#reloadAnalyticsBtn').addEventListener('click', () => loadPublicos().catch(() => {}));
    $('#productPeriod').addEventListener('change', () => loadProductAnalytics().catch(() => {}));
    $$('.publicos-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.publicos-tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const targetId = `tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`;
        $$('.publicos-panel').forEach((p) => p.classList.toggle('is-active', p.id === targetId));
      });
    });
    $('#audiencesList').addEventListener('click', async (e) => {
      const evalBtn = e.target.closest('[data-evaluate-audience]');
      if (evalBtn) {
        setButtonLoading(evalBtn, true, '…');
        try {
          const result = await api(`/api/v1/audiences/${encodeURIComponent(evalBtn.dataset.evaluateAudience)}/evaluate`, { method: 'POST' });
          toast(`${result.contact_count.toLocaleString('pt-BR')} contatos elegíveis.`);
          await loadAudiences();
        } catch (err) {
          toast(`Erro: ${err.message}`, 'error');
        } finally {
          setButtonLoading(evalBtn, false);
        }
        return;
      }
      const editBtn = e.target.closest('[data-edit-audience]');
      if (editBtn) {
        const audience = state.audiences.find((a) => a.id === editBtn.dataset.editAudience);
        if (audience) openAudienceModal(audience);
        return;
      }
      const delBtn = e.target.closest('[data-delete-audience]');
      if (delBtn) {
        if (!confirm(`Excluir público "${delBtn.dataset.deleteName}"?`)) return;
        try {
          await api(`/api/v1/audiences/${encodeURIComponent(delBtn.dataset.deleteAudience)}`, { method: 'DELETE' });
          toast('Público excluído.');
          await loadAudiences();
        } catch (err) {
          toast(`Erro: ${err.message}`, 'error');
        }
      }
    });
  }

  async function init() {
    populateStages();
    bindEvents();
    await checkHealth();
    await restoreSession();
  }

  init();
})();
