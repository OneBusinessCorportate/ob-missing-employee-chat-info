#!/usr/bin/env python3
"""Extract the client-count reconciliation snapshots from the three OB Excel
sources into data/recon/*.jsonl.

These snapshots feed the "Контроль количества клиентов" dashboard
(lib/clientCount.js). They are committed to the repo so the dashboard has the
full "all companies from all sources" list at runtime without needing the raw
Excel files. Re-run this whenever the source sheets are refreshed:

    python3 scripts/extract-recon-sources.py \
        --agreements "OB Agreements and Invoices 2025-2026.xlsx" \
        --chats "Чаты.xlsx" \
        --onebusiness "One Business.xlsx"

Only real data is read; nothing is written back to any Google Sheet / Excel.
"""
import argparse
import json
import os
import re

import openpyxl


def s(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        v = int(v)
    return str(v).strip()


def norm_hvhh(v):
    return re.sub(r"\D", "", s(v))


def norm_agr(v):
    return re.sub(r"\.0$", "", s(v))


def load(path, sheet, header_row):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    hdr = [s(c) for c in rows[header_row]]
    return hdr, rows[header_row + 1:]


def col(hdr, *names):
    for n in names:
        for i, h in enumerate(hdr):
            if h.lower().strip() == n.lower().strip():
                return i
    for n in names:
        for i, h in enumerate(hdr):
            if n.lower().strip() in h.lower().strip():
                return i
    return None


def get(r, i):
    return r[i] if i is not None and i < len(r) else None


def dump(out_dir, name, recs):
    with open(os.path.join(out_dir, name + ".jsonl"), "w") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{name}: {len(recs)} rows")
    return len(recs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agreements", required=True, help="OB Agreements & Invoices xlsx")
    ap.add_argument("--chats", required=True, help="Chats (Чаты) xlsx")
    ap.add_argument("--onebusiness", required=True, help="One Business xlsx")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "recon"))
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    counts = {}

    # 1) Agreements master list (HVHH of every client, incl. inactive/exceptions)
    hdr, data = load(args.agreements, "Agreements", 1)
    i_id, i_co, i_hv, i_st = (col(hdr, "ID"), col(hdr, "Company"),
                              col(hdr, "HVHH"), col(hdr, "Status"))
    recs = []
    for r in data:
        agr, co, hv, st = norm_agr(get(r, i_id)), s(get(r, i_co)), norm_hvhh(get(r, i_hv)), s(get(r, i_st))
        if not co and not hv:
            continue
        recs.append({"agr_no": agr, "company": co, "hvhh": hv, "status": st})
    counts["agreements"] = dump(out, "agreements", recs)

    # 2) Refuseniks (left / refused clients)
    hdr, data = load(args.agreements, "Отказники", 0)
    i_no, i_nm = col(hdr, "№ договора"), col(hdr, "Название клиента")
    i_dt, i_rs, i_tp = col(hdr, "Дата ухода"), col(hdr, "Причина ухода"), col(hdr, "Тип проблемы")
    recs = []
    for r in data:
        nm, no = s(get(r, i_nm)), norm_agr(get(r, i_no))
        if not (nm or no):
            continue
        recs.append({"agr_no": no, "company": nm, "left_date": s(get(r, i_dt)),
                     "reason": s(get(r, i_rs)), "problem_type": s(get(r, i_tp))})
    counts["refuseniks"] = dump(out, "refuseniks", recs)

    # 3) Chats sheet (agreement -> Telegram chat linkage)
    hdr, data = load(args.chats, "Чаты", 0)
    i_no, i_hv = col(hdr, "№ agr."), col(hdr, "HVHH")
    i_na, i_nt = col(hdr, "Name from agr.list"), col(hdr, "Name from Tax")
    i_st, i_cn, i_cl = col(hdr, "Status"), col(hdr, "Chat name"), col(hdr, "Chat LINK")
    recs = []
    for r in data:
        hv, na, no = norm_hvhh(get(r, i_hv)), s(get(r, i_na)), norm_agr(get(r, i_no))
        if not (hv or na or no):
            continue
        recs.append({"agr_no": no, "hvhh": hv, "name_agr": na, "name_tax": s(get(r, i_nt)),
                     "status": s(get(r, i_st)), "chat_name": s(get(r, i_cn)),
                     "chat_link": s(get(r, i_cl))})
    counts["chats_sheet"] = dump(out, "chats_sheet", recs)

    # 4) Chats without bot (account export: which chats have the bot)
    hdr, data = load(args.chats, "Chats without bot", 0)
    i_cn, i_be = col(hdr, "Chat name"), col(hdr, "Bot exists")
    i_ci, i_cl, i_it = col(hdr, "Chat ID"), col(hdr, "Chat link"), col(hdr, "Issue type")
    recs = []
    for r in data:
        cn = s(get(r, i_cn))
        if not cn:
            continue
        recs.append({"chat_name": cn, "bot_exists": s(get(r, i_be)), "chat_id": s(get(r, i_ci)),
                     "chat_link": s(get(r, i_cl)), "issue_type": s(get(r, i_it))})
    counts["chats_without_bot"] = dump(out, "chats_without_bot", recs)

    # 5) One Business main data (client master with accountant, HVHH, status)
    hdr, data = load(args.onebusiness, "Основные данные", 0)
    i_no, i_nm, i_fee = col(hdr, "№ договора"), col(hdr, "Имя клиента"), col(hdr, "Сумма оплаты")
    i_hv, i_tn = col(hdr, "ՀՎՀՀ"), col(hdr, "Наименование клиента")
    i_st, i_ac = col(hdr, "Պայմանագրի կարգավիճակ"), col(hdr, "Бухгалтер")
    recs = []
    for r in data:
        nm, hv, no = s(get(r, i_nm)), norm_hvhh(get(r, i_hv)), norm_agr(get(r, i_no))
        if not (nm or hv or no):
            continue
        recs.append({"agr_no": no, "client_name": nm, "hvhh": hv, "tax_name": s(get(r, i_tn)),
                     "status": s(get(r, i_st)), "accountant": s(get(r, i_ac)),
                     "monthly_fee": s(get(r, i_fee))})
    counts["onebusiness"] = dump(out, "onebusiness", recs)

    # 6) Name exceptions
    hdr, data = load(args.onebusiness, "Exceptions", 0)
    i_nm, i_cm = col(hdr, "Name"), col(hdr, "Comment")
    recs = []
    for r in data:
        nm = s(get(r, i_nm))
        if not nm:
            continue
        recs.append({"name": nm, "comment": s(get(r, i_cm))})
    counts["name_exceptions"] = dump(out, "name_exceptions", recs)

    meta = {
        "extracted_on": "regenerated",
        "note": "Snapshots extracted from the three OB Excel sources by scripts/extract-recon-sources.py.",
        "row_counts": counts,
    }
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), ensure_ascii=False, indent=2)
    print("DONE", counts)


if __name__ == "__main__":
    main()
