// services/api/src/services/payrollAuto.service.js
// Option A: Auto-generate paystubs for "Locked" payrollPeriods whose payDate is TODAY (ET).
// - Firestore: paystubs + ytd + companyMetrics + payrollPeriods
// - Cloudinary: PDF upload (pdfUrl)
// - NO EMAIL here (emailed: false) → front-end GmailAuth se bhejayega

const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

const {
  getTaxRatesByState,
  calcEarnings,
  calcPreTax,
  calcEmployeeTaxes,
  calcPostTax,
  calcEmployerTaxes,
  calcNetPay,
  calcGrossProfit,
} = require('../lib/payroll');

const { buildPaystubPdfBuffer } = require('./paystubPdf.service');
const { cloudinary } = require('./cloudinary');

function getDb() {
  if (!process.env.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID is required for payroll auto-run');
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }
  return admin.firestore();
}

// Helper: ET time (yyyy-mm-dd + HH:MM)
function nowInET() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dateISO = `${get('year')}-${get('month')}-${get('day')}`;
  const timeHHMM = `${get('hour')}:${get('minute')}`;
  return { dateISO, timeHHMM };
}

async function loadPayrollConfig(db) {
  const ref = db.collection('payrollConfig').doc('company');
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: ref.id, ref, data: snap.data() || {} };
}

async function getYTD(db, employeeId) {
  const ref = db.collection('ytd').doc(employeeId);
  const snap = await ref.get();
  if (!snap.exists) return { ref, data: { gross: 0, deductions: 0, net: 0 } };
  return { ref, data: snap.data() || { gross: 0, deductions: 0, net: 0 } };
}

async function saveYTD(ref, nextYTD) {
  await ref.set(nextYTD, { merge: true });
}

async function bumpCompanyGrossProfit(db, year, deltaGP) {
  const id = `gp_${year}`;
  const ref = db.collection('companyMetrics').doc(id);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data().grossProfitYTD || 0 : 0;
  await ref.set(
    {
      year,
      grossProfitYTD: prev + deltaGP,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// Cloudinary helper: upload PDF buffer → secure_url
function uploadPaystubPdfToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'paystubs',
        public_id: publicId,
        resource_type: 'raw',
        format: 'pdf',
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result || !result.secure_url) {
          return reject(new Error('Cloudinary response missing secure_url'));
        }
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// Build form from employee + period
function buildFormFromEmployeeAndPeriod(emp, period) {
  const payroll = emp.payroll || {};
  const state = payroll.state || emp.state || 'FL';
  const rate = Number(payroll.hourlyRate || 0);
  const hours = Number(payroll.biweeklyHoursDefault || 0);

  if (!rate || !hours) {
    return null; // missing defaults → skip
  }

  const overtimeMultiplier = Number(payroll.overtimeRate || 1.5);

  const addressParts = [];
  if (emp.address) addressParts.push(emp.address);
  const cityStateZip = [emp.city, emp.state, emp.zip].filter(Boolean).join(' ');
  if (cityStateZip) addressParts.push(cityStateZip);
  const address = addressParts.join(', ');

  const form = {
    id: emp.id || emp.uid || emp._id || emp.documentId || null,
    name: emp.name || emp.legalName || 'Employee',
    email: emp.email || emp.personalEmail || null,
    address,
    state,
    payType: 'Hourly',
    paySchedule: 'Bi-Weekly',
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    payDate: period.payDate,
    rate: String(rate),
    hours: String(hours),
    overtimeHours: '0',
    overtimeMultiplier,
    annualSalary: '',
    billRate: String(payroll.billRate || 0),
    bonus: '0',
    commission: '0',
    reimbursements: '0',
    preTax401kPct: '0',
    preTaxHealth: '0',
    postTaxGarnishment: '0',
  };

  return { form, rate, hours, overtimeMultiplier };
}

async function runAutoPayrollForToday({ dryRun = false } = {}) {
  const db = getDb();
  const { dateISO, timeHHMM } = nowInET();
  const year = Number(dateISO.slice(0, 4));

  const cfgDoc = await loadPayrollConfig(db);
  if (!cfgDoc) {
    return { ok: false, reason: 'noConfig', message: 'payrollConfig/company missing' };
  }
  const cfg = cfgDoc.data;
  if (!cfg.firstPayDate) {
    return { ok: false, reason: 'missingFirstPayDate', message: 'firstPayDate missing in payrollConfig' };
  }
  if (!cfg.autoRunEnabled) {
    return { ok: true, reason: 'autoRunDisabled', dateISO, timeHHMM };
  }

  const payHourET = cfg.payHourET || '08:00';
  if (timeHHMM < payHourET) {
    return {
      ok: true,
      reason: 'beforePayHour',
      dateISO,
      timeHHMM,
      payHourET,
    };
  }

  const periodsSnap = await db
    .collection('payrollPeriods')
    .where('payDate', '==', dateISO)
    .get();

  if (periodsSnap.empty) {
    await cfgDoc.ref.set(
      {
        lastAutoRunAt: FieldValue.serverTimestamp(),
        lastAutoRunSummary: {
          dateISO,
          timeHHMM,
          count: 0,
          reason: 'noPeriods',
        },
      },
      { merge: true }
    );
    return { ok: true, dateISO, timeHHMM, count: 0, message: 'No payrollPeriods due today' };
  }

  const results = [];
  let generatedCount = 0;
  let skippedAlreadyGenerated = 0;
  let skippedMissingEmployee = 0;
  let skippedMissingDefaults = 0;

  for (const docSnap of periodsSnap.docs) {
    const period = docSnap.data() || {};
    const status = period.status || 'Scheduled';
    const employeeId = period.employeeId || (docSnap.id.split('__')[0] || null);

    if (!employeeId) {
      skippedMissingEmployee++;
      continue;
    }

    if (status !== 'Locked') {
      results.push({ id: docSnap.id, status, skipped: 'notLocked' });
      continue;
    }

    const stubId = `${employeeId}_${period.payDate}`;
    const stubRef = db.collection('paystubs').doc(stubId);
    const existingStub = await stubRef.get();
    if (existingStub.exists) {
      skippedAlreadyGenerated++;
      results.push({ id: docSnap.id, employeeId, skipped: 'stubExists' });
      continue;
    }

    const empRef = db.collection('w9Info').doc(employeeId);
    const empSnap = await empRef.get();
    if (!empSnap.exists) {
      skippedMissingEmployee++;
      results.push({ id: docSnap.id, employeeId, skipped: 'w9Missing' });
      continue;
    }
    const empData = empSnap.data() || {};
    const emp = { id: employeeId, ...empData };

    const built = buildFormFromEmployeeAndPeriod(emp, period);
    if (!built) {
      skippedMissingDefaults++;
      results.push({ id: docSnap.id, employeeId, skipped: 'missingPayrollDefaults' });
      continue;
    }
    const { form, rate, hours, overtimeMultiplier } = built;

    const rates = getTaxRatesByState(form.state);
    const bonus = 0;
    const commission = 0;
    const reimbursements = 0;
    const preTax401kPct = 0;
    const preTaxHealth = 0;
    const postTaxGarnishment = 0;
    const overtimeHours = 0;

    const earn = calcEarnings({
      rate,
      hours,
      overtimeHours,
      overtimeMultiplier,
      bonus,
      commission,
    });

    const pre = calcPreTax({ gross: earn.gross, preTax401kPct, preTaxHealth });
    const empTax = calcEmployeeTaxes({ taxableWages: pre.taxableWages, rates });
    const post = calcPostTax({ postTaxGarnishment });
    const net = calcNetPay({
      gross: earn.gross,
      preTaxTotal: pre.preTaxTotal,
      employeeTaxes: empTax,
      postTaxTotal: post.postTaxTotal,
      reimbursements,
    });

    const erTax = calcEmployerTaxes({ gross: earn.gross, rates });
    const gp = calcGrossProfit({
      billRate: Number(form.billRate || 0),
      hours,
      gross: earn.gross,
      employerTaxesTotal: erTax.employerTaxTotal,
      employerBenefits: 0,
      reimbursements,
    });

    const { ref: ytdRef, data: ytd } = await getYTD(db, employeeId);
    const nextYTD = {
      gross: +(ytd.gross + earn.gross).toFixed(2),
      deductions: +(ytd.deductions + (net.deductions || 0)).toFixed(2),
      net: +(ytd.net + net.net).toFixed(2),
    };

    const payload = {
      ...form,
      gross: +earn.gross.toFixed(2),
      preTaxTotal: +pre.preTaxTotal.toFixed(2),
      federal: +empTax.federal.toFixed(2),
      stateTax: +empTax.state.toFixed(2),
      ss: +empTax.ss.toFixed(2),
      medicare: +empTax.medicare.toFixed(2),
      postTaxTotal: +post.postTaxTotal.toFixed(2),
      deductions: +net.deductions.toFixed(2),
      net: +net.net.toFixed(2),
      employerTaxes: {
        ssEr: +erTax.ssEr.toFixed(2),
        medicareEr: +erTax.medicareEr.toFixed(2),
        futa: +erTax.futa.toFixed(2),
        suta: +erTax.suta.toFixed(2),
        employerTaxTotal: +erTax.employerTaxTotal.toFixed(2),
      },
      revenue: +gp.revenue.toFixed(2),
      employerCost: +gp.employerCost.toFixed(2),
      grossProfit: +gp.gp.toFixed(2),
      ytdGross: nextYTD.gross,
      ytdDeductions: nextYTD.deductions,
      ytdNet: nextYTD.net,
      approveDate: period.periodStart,
      autoGenerated: true,
      autoRunAt: FieldValue.serverTimestamp(),
      emailed: false,           // ✅ Option A: email abhi nahi gaya
      emailError: null,
    };

    if (dryRun) {
      results.push({ id: docSnap.id, employeeId, dryRun: true, payloadPreview: payload });
      continue;
    }

    // Core writes
    await stubRef.set(
      {
        ...payload,
        createdAt: FieldValue.serverTimestamp(),
        mode: 'auto',
        source: 'payrollAuto',
      },
      { merge: true }
    );

    await saveYTD(ytdRef, nextYTD);
    await bumpCompanyGrossProfit(db, year, gp.gp);

    // PDF + Cloudinary (no email)
    let pdfUrl = null;
    try {
      const pdfBuffer = await buildPaystubPdfBuffer({
        ...payload,
        name: form.name,
        email: form.email,
        address: form.address,
        state: form.state,
      });

      pdfUrl = await uploadPaystubPdfToCloudinary(pdfBuffer, stubId);

      await stubRef.set({ pdfUrl }, { merge: true });
    } catch (err) {
      console.error('Paystub Cloudinary upload failed', employeeId, err);
      await stubRef.set(
        {
          pdfUrl: null,
          pdfError: err.message || String(err),
        },
        { merge: true }
      );
    }

    await docSnap.ref.set(
      {
        status: 'Generated',
        updatedAt: FieldValue.serverTimestamp(),
        autoGenerated: true,
        autoStubId: stubId,
        pdfUrl: pdfUrl || null,
        inputsSnapshot: form,
        calcSnapshot: {
          gross: payload.gross,
          preTaxTotal: payload.preTaxTotal,
          federal: payload.federal,
          stateTax: payload.stateTax,
          ss: payload.ss,
          medicare: payload.medicare,
          postTaxTotal: payload.postTaxTotal,
          deductions: payload.deductions,
          net: payload.net,
          revenue: payload.revenue,
          employerCost: payload.employerCost,
          grossProfit: payload.grossProfit,
        },
      },
      { merge: true }
    );

    generatedCount++;
    results.push({ id: docSnap.id, employeeId, stubId, generated: true, pdfUrl: pdfUrl || undefined });
  }

  if (!dryRun) {
    await cfgDoc.ref.set(
      {
        lastAutoRunAt: FieldValue.serverTimestamp(),
        lastAutoRunSummary: {
          dateISO,
          timeHHMM,
          generatedCount,
          skippedAlreadyGenerated,
          skippedMissingEmployee,
          skippedMissingDefaults,
          totalPeriods: periodsSnap.size,
        },
      },
      { merge: true }
    );
  }

  return {
    ok: true,
    dateISO,
    timeHHMM,
    generatedCount,
    skippedAlreadyGenerated,
    skippedMissingEmployee,
    skippedMissingDefaults,
    totalPeriods: periodsSnap.size,
    dryRun,
    results,
  };
}

module.exports = {
  runAutoPayrollForToday,
};
