// services/api/src/lib/payroll.js
// Simple, practical estimates (NOT legal/tax advice)
const STATE_CONFIG = {
  FL: { stateRate: 0 },         // Florida ~0% income tax
  NC: { stateRate: 0.045 },     // Example flat rate (adjust if needed)
};

function getTaxRatesByState(stateCode = "FL") {
  const state = STATE_CONFIG[stateCode] || STATE_CONFIG.FL;
  return {
    federal: 0.12,          // rough est.
    state: state.stateRate, // FL=0, NC=4.5%
    ssEmployee: 0.062,
    medicareEmployee: 0.0145,
    ssEmployer: 0.062,
    medicareEmployer: 0.0145,
    futaEmployer: 0.006,    // employer only
    sutaEmployer: stateCode === "NC" ? 0.012 : 0.027, // example
  };
}

function calcEarnings({ rate, hours, overtimeHours = 0, overtimeMultiplier = 1.5, bonus = 0, commission = 0 }) {
  const base = rate * hours;
  const overtime = rate * overtimeMultiplier * overtimeHours;
  const gross = base + overtime + bonus + commission;
  return { base, overtime, gross };
}

function calcPreTax({ gross, preTax401kPct = 0, preTaxHealth = 0 }) {
  const preTax401k = gross * (preTax401kPct / 100);
  const preTaxTotal = preTax401k + preTaxHealth;
  const taxableWages = Math.max(0, gross - preTaxTotal);
  return { preTax401k, preTaxTotal, taxableWages };
}

function calcEmployeeTaxes({ taxableWages, rates }) {
  const federal = taxableWages * rates.federal;
  const state = taxableWages * rates.state;
  const ss = taxableWages * rates.ssEmployee;
  const medicare = taxableWages * rates.medicareEmployee;
  const taxesTotal = federal + state + ss + medicare;
  return { federal, state, ss, medicare, taxesTotal };
}

function calcPostTax({ postTaxGarnishment = 0 }) {
  return { postTaxTotal: postTaxGarnishment };
}

function calcEmployerTaxes({ gross, rates }) {
  const ssEr = gross * rates.ssEmployer;
  const medicareEr = gross * rates.medicareEmployer;
  const futa = gross * rates.futaEmployer;
  const suta = gross * rates.sutaEmployer;
  const employerTaxTotal = ssEr + medicareEr + futa + suta;
  return { ssEr, medicareEr, futa, suta, employerTaxTotal };
}

function calcNetPay({ gross, preTaxTotal, employeeTaxes, postTaxTotal, reimbursements = 0 }) {
  // reimbursements add back to take-home, usually non-taxable
  const deductions = preTaxTotal + employeeTaxes.taxesTotal + postTaxTotal;
  const net = Math.max(0, gross - deductions) + reimbursements;
  return { deductions, net };
}

function calcGrossProfit({
  billRate = 0,
  hours = 0,
  gross,                      // employee gross wages
  employerTaxesTotal = 0,
  employerBenefits = 0,       // optional future
  reimbursements = 0,         // pass-through, not cost to company
}) {
  const revenue = billRate * hours;
  const employerCost = gross + employerTaxesTotal + employerBenefits; // reimbursements not counted as cost
  const gp = revenue - employerCost;
  return { revenue, employerCost, gp };
}

module.exports = {
  STATE_CONFIG,
  getTaxRatesByState,
  calcEarnings,
  calcPreTax,
  calcEmployeeTaxes,
  calcPostTax,
  calcEmployerTaxes,
  calcNetPay,
  calcGrossProfit,
};
