// The one place the reseller fee math lives: platform rates, formulas, and
// the dates each rate was last verified.
//
// Used two ways from this single file:
//   - the browser calculator, the blog embeds and the checker pages load it as
//     /fee-calc.js (Eleventy copies it, see .eleventy.js) and read window.FeeCalc
//   - the MCP server (lib/mcp-server.js) require()s it
//
// Presentation details (badge letters, affiliate links) stay in src/script.js.
// To change a rate, change it here and bump lastVerified.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FeeCalc = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLATFORM_FEES = [
    {
      id: 'ebay',
      name: 'eBay',
      lastVerified: '2026-08-06',
      feeOnShipping: true,
      calc(price, { ship = 0, promoRate = 0 } = {}) {
        const total = price + ship;
        const fvf = Math.min(total, 7500) * 0.136 + Math.max(total - 7500, 0) * 0.0235 + (total > 10 ? 0.40 : 0.30);
        const adFee = total * promoRate / 100;
        const breakdown = '13.6% + $0.30–$0.40' + (promoRate > 0 ? ' + ' + promoRate + '% ads' : '');
        return { fee: fvf + adFee, breakdown };
      }
    },
    {
      id: 'poshmark',
      name: 'Poshmark',
      lastVerified: '2026-08-06',
      buyerPaysShipping: true,
      calc(price) {
        const fee = price < 15 ? 2.95 : price * 0.20;
        return { fee, breakdown: price < 15 ? '$2.95 flat (under $15)' : '20% (over $15)' };
      }
    },
    {
      id: 'mercari',
      name: 'Mercari',
      // Mercari's 10% applies to "the item price + buyer-paid shipping"
      // (help center article 169, verified 2026-10-01). Seller-paid
      // shipping stays out of the base, so leave shipping blank for that case.
      lastVerified: '2026-10-01',
      feeOnShipping: true,
      calc(price, { ship = 0 } = {}) {
        const fee = (price + ship) * 0.10;
        return { fee, breakdown: '10% flat' };
      }
    },
    {
      id: 'depop',
      name: 'Depop',
      lastVerified: '2026-08-06',
      feeOnShipping: true,
      calc(price, { ship = 0 } = {}) {
        const fee = (price + ship) * 0.033 + 0.45;
        return { fee, breakdown: '0% + 3.3% + $0.45' };
      }
    },
    {
      id: 'etsy',
      name: 'Etsy',
      lastVerified: '2026-08-06',
      feeOnShipping: true,
      calc(price, { ship = 0 } = {}) {
        const total = price + ship;
        const fee = 0.20 + total * 0.065 + total * 0.03 + 0.25;
        return { fee, breakdown: '$0.20 + 6.5% + 3% + $0.25' };
      }
    },
    {
      id: 'grailed',
      name: 'Grailed',
      lastVerified: '2026-08-06',
      calc(price) {
        const commission = price < 120 ? Math.max(price * 0.06, 1.99) : price * 0.09;
        const fee = commission + price * 0.0349 + 0.49;
        return { fee, breakdown: price < 120 ? '6% (min $1.99) + 3.49% + $0.49' : '9% + 3.49% + $0.49' };
      }
    },
    {
      id: 'vinted',
      name: 'Vinted',
      lastVerified: '2026-08-06',
      buyerPaysShipping: true,
      calc() {
        return { fee: 0, breakdown: '0% — seller pays nothing' };
      }
    }
  ];

  function calcPlatformResult(platform, price, { shipCharged = 0, itemCost = 0, shipCost = 0, promoRate = 0 } = {}) {
    // Poshmark and Vinted: the buyer always pays the label, so shipping
    // is ignored. Elsewhere shipping only joins the fee base on
    // platforms that charge fees on it (eBay, Etsy, Depop).
    const ship = platform.buyerPaysShipping ? 0 : shipCharged;
    const postage = platform.buyerPaysShipping ? 0 : shipCost;
    const { fee, breakdown } = platform.calc(price, { ship: platform.feeOnShipping ? ship : 0, promoRate });
    const revenue = price + ship;
    const net = revenue - fee;
    const profit = net - itemCost - postage;
    const margin = revenue > 0 ? profit / revenue * 100 : 0;
    const roi = itemCost > 0 ? profit / itemCost * 100 : null;
    return { name: platform.name, fee, net, profit, margin, roi, breakdown };
  }

  const cents = n => Math.round(n * 100) / 100;

  // Rounded to cents and sorted for API consumers (the MCP compare_fees tool):
  // by profit when costs are given, otherwise by what the seller keeps.
  function compareFees(price, { shipCharged = 0, itemCost = 0, shipCost = 0, promoRate = 0 } = {}) {
    const includeProfit = itemCost > 0 || shipCost > 0;
    return PLATFORM_FEES
      .map(platform => {
        const r = calcPlatformResult(platform, price, { shipCharged, itemCost, shipCost, promoRate });
        const row = {
          platform: platform.id,
          name: platform.name,
          fee: cents(r.fee),
          you_keep: cents(r.net),
          fee_breakdown: r.breakdown,
          rates_last_verified: platform.lastVerified
        };
        if (includeProfit) {
          row.profit = cents(r.profit);
          row.margin_percent = cents(r.margin);
          row.roi_percent = r.roi === null ? null : cents(r.roi);
        }
        return row;
      })
      .sort((a, b) => includeProfit ? b.profit - a.profit : b.you_keep - a.you_keep);
  }

  return { PLATFORM_FEES, calcPlatformResult, compareFees };
}));
