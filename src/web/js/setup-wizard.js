// Meridian ERP :: web/setup-wizard
// The first thing anyone sees on a brand-new copy. It creates the company and
// its administrator; until that is done there is nobody to sign in as, so this
// screen is deliberately the whole application.
import { h, mount, $ } from './dom.js';
import { API, setCsrf } from './api.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Mirror of the server's password rule, so the error appears as you type. */
function passwordProblems(pw) {
  const out = [];
  if (!pw || pw.length < 12) out.push('be at least 12 characters');
  if (!/[a-z]/.test(pw || '')) out.push('include a lower-case letter');
  if (!/[A-Z]/.test(pw || '')) out.push('include a capital letter');
  if (!/[0-9]/.test(pw || '')) out.push('include a digit');
  return out;
}

export async function renderSetup(app, onDone) {
  const state = await API.setupState();

  const company = h('input', { type: 'text', autocomplete: 'organization', placeholder: 'Larkspur Instruments Ltd', required: true });
  const fullName = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Ana Vidal', required: true });
  const emailInput = h('input', { type: 'email', autocomplete: 'username', placeholder: 'you@company.com', required: true });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const confirmPw = h('input', { type: 'password', autocomplete: 'new-password', required: true });

  const country = h('select', ...state.countries.map((c) =>
    h('option', { value: c.code, selected: c.code === 'US' }, c.name)));
  const currency = h('select', ...state.currencies.map((c) =>
    h('option', { value: c.code, selected: c.code === 'USD' }, `${c.code} — ${c.name}`)));

  const thisYear = new Date().getFullYear();
  const fiscalYear = h('select', ...[thisYear - 1, thisYear, thisYear + 1].map((y) =>
    h('option', { value: y, selected: y === thisYear }, String(y))));

  // Picking a country is a much better guess at the currency than leaving it
  // on dollars, but it stays editable.
  country.addEventListener('change', () => {
    const match = state.countries.find((c) => c.code === country.value);
    if (match && [...currency.options].some((o) => o.value === match.currency)) currency.value = match.currency;
  });

  const sample = h('input', { type: 'checkbox' });
  const pwHelp = h('div.help', 'At least 12 characters, with a capital, a lower-case letter and a digit.');
  password.addEventListener('input', () => {
    const problems = passwordProblems(password.value);
    pwHelp.textContent = password.value && problems.length
      ? `Password must ${problems.join(', ')}.`
      : 'At least 12 characters, with a capital, a lower-case letter and a digit.';
    pwHelp.classList.toggle('err', !!password.value && problems.length > 0);
  });

  const errBox = h('div.login-error.hidden');
  const submit = h('button.btn.primary', { type: 'submit', style: { width: '100%', height: '34px', justifyContent: 'center' } },
    'Create company');

  const fail = (message, field) => {
    errBox.textContent = message;
    errBox.classList.remove('hidden');
    errBox.scrollIntoView({ block: 'nearest' });
    field?.focus();
  };

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');

      if (!company.value.trim()) return fail('Give the company a name.', company);
      if (passwordProblems(password.value).length) {
        return fail(`Password must ${passwordProblems(password.value).join(', ')}.`, password);
      }
      if (password.value !== confirmPw.value) return fail('The two passwords do not match.', confirmPw);

      submit.disabled = true;
      submit.textContent = sample.checked ? 'Creating company and loading sample data…' : 'Creating company…';
      try {
        await API.provision({
          company_name: company.value.trim(),
          full_name: fullName.value.trim() || 'Administrator',
          email: emailInput.value.trim(),
          password: password.value,
          country: country.value,
          currency: currency.value,
          fiscal_year: Number(fiscalYear.value),
          sample_data: sample.checked,
        });
        // Sign straight in: making someone re-type what they just chose is a
        // pointless extra step.
        const session = await API.login(emailInput.value.trim(), password.value);
        setCsrf(session.csrf);
        await onDone();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Create company';
        fail(err.message || 'Could not create the company.');
      }
    },
  },
    errBox,
    h('div.setup-section', 'Your company'),
    h('div.field', h('label', 'Company name'), company),
    h('div.setup-row',
      h('div.field', h('label', 'Country'), country),
      h('div.field', h('label', 'Base currency'), currency)),
    h('div.field', h('label', 'First financial year'), fiscalYear,
      h('div.help', `Accounting periods are created for ${thisYear - 1} through ${thisYear + 1}. `
        + `The year starts in ${MONTHS[0]}; you can change that in Setup afterwards.`)),

    h('div.setup-section', 'Your administrator account'),
    h('div.field', h('label', 'Your name'), fullName),
    h('div.field', h('label', 'Email'), emailInput,
      h('div.help', 'This is what you sign in with. It is stored on this machine only.')),
    h('div.field', h('label', 'Password'), password, pwHelp),
    h('div.field', h('label', 'Confirm password'), confirmPw),

    h('div.setup-section', 'Starting data'),
    h('label.setup-check',
      sample,
      h('div',
        h('div', { style: { fontWeight: 600 } }, 'Include sample data'),
        h('div.help', 'Six months of invented trading history — customers, stock, invoices, '
          + 'projects and payroll — so every screen has something to show. Good for a trial; '
          + 'leave it off to start on your own books.'))),
    submit);

  mount(app, h('div.login-wrap',
    h('div.login-card.setup-card',
      h('div.login-brand', h('div.brand-mark', 'M'), h('div.login-title', 'Meridian')),
      h('div.login-sub', `Welcome. Let's set up your company — this takes about a minute.`),
      form)));

  setTimeout(() => company.focus(), 60);
}
