sap.ui.define([], function () {
    "use strict";

    return {

        /* ─── Dispatch status ───────────────────────────────────────── */

        dispatchState: function (sStatus) {
            switch (sStatus) {
                case "APPROVED": return "Success";
                case "BLOCKED":  return "Error";
                case "REVIEW":   return "Warning";
                default:         return "Warning";
            }
        },

        dispatchIcon: function (sStatus) {
            switch (sStatus) {
                case "APPROVED": return "sap-icon://accept";
                case "BLOCKED":  return "sap-icon://error";
                case "REVIEW":   return "sap-icon://pending";
                default:         return "sap-icon://pending";
            }
        },

        verdictStripType: function (sStatus) {
            switch (sStatus) {
                case "APPROVED": return "Success";
                case "BLOCKED":  return "Error";
                case "REVIEW":   return "Warning";
                default:         return "Warning";
            }
        },

        /* ─── HU status (3-tier: Passed / Review / Failed) ─────────── */

        huStatusState: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "Success";
                case "Review": return "Warning";
                case "Failed": return "Error";
                default:       return "None";
            }
        },

        huStatusIcon: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "sap-icon://accept";
                case "Review": return "sap-icon://pending";
                case "Failed": return "sap-icon://error";
                default:       return "sap-icon://question-mark";
            }
        },

        huHighlight: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "Success";
                case "Review": return "Warning";
                case "Failed": return "Error";
                default:       return "None";
            }
        },

        // Legacy — kept for backward compat with any existing bindings
        huPassedState: function (bPassed, bBlocked) {
            if (bBlocked) return "Warning";
            return bPassed ? "Success" : "Error";
        },
        huPassedText: function (bPassed, bBlocked) {
            if (bBlocked) return "Blocked";
            return bPassed ? "Passed" : "Failed";
        },
        huPassedIcon: function (bPassed, bBlocked) {
            if (bBlocked) return "sap-icon://alert";
            return bPassed ? "sap-icon://accept" : "sap-icon://error";
        },

        /* ─── Label status ──────────────────────────────────────────── */

        labelStatusState: function (sLabel) {
            switch ((sLabel || "OK").toUpperCase()) {
                case "OK":      return "Success";
                case "DAMAGED": return "Warning";
                case "MISSING": return "Error";
                default:        return "None";
            }
        },

        labelStatusIcon: function (sLabel) {
            switch ((sLabel || "OK").toUpperCase()) {
                case "OK":      return "sap-icon://accept";
                case "DAMAGED": return "sap-icon://alert";
                case "MISSING": return "sap-icon://decline";
                default:        return "sap-icon://question-mark";
            }
        },

        /* ─── Stacking compliance ───────────────────────────────────── */

        stackingState: function (bCompliant) {
            return bCompliant === false ? "Warning" : "Success";
        },

        stackingText: function (bCompliant) {
            return bCompliant === false ? "Non-Compliant" : "Compliant";
        },

        /* ─── Severity ──────────────────────────────────────────────── */

        severityState: function (sSeverity) {
            switch (sSeverity) {
                case "Critical": return "Error";
                case "High":     return "Error";
                case "Medium":   return "Warning";
                case "Low":      return "Success";
                default:         return "None";
            }
        },

        /* ─── Weight delta ──────────────────────────────────────────── */

        weightDeltaNumber: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) return null;
            return parseFloat(((nActual - nExpected) / nExpected * 100).toFixed(2));
        },

        weightDeltaState: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) return "None";
            var fAbs = Math.abs((nActual - nExpected) / nExpected * 100);
            if (fAbs > 5) return "Error";
            if (fAbs > 2) return "Warning";
            return "Success";
        },

        weightDeltaText: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) return "N/A";
            var fDelta = (nActual - nExpected) / nExpected * 100;
            return (fDelta >= 0 ? "+" : "") + fDelta.toFixed(2) + "%";
        },

        /* ─── Exception ─────────────────────────────────────────────── */

        exceptionIcon: function (sType) {
            switch (sType) {
                case "BLOCKED":  return "sap-icon://locked";
                case "WEIGHT":   return "sap-icon://scale";
                case "LABEL":    return "sap-icon://tag";
                case "STACKING": return "sap-icon://stack-alert";
                case "CLOSED":   return "sap-icon://cancel";
                default:         return "sap-icon://alert";
            }
        },

        exceptionColor: function (sType) {
            return (sType === "BLOCKED" || sType === "CLOSED") ? "red" : "orange";
        },

        exceptionState: function (sType) {
            return (sType === "BLOCKED" || sType === "CLOSED") ? "Error" : "Warning";
        },

        /* ─── History / worklist ────────────────────────────────────── */

        statusState: function (sStatus) {
            switch (sStatus) {
                case "APPROVED": return "Success";
                case "BLOCKED":  return "Error";
                case "REVIEW":   return "Warning";
                default:         return "Warning";
            }
        },

        statusHighlight: function (sStatus) {
            switch (sStatus) {
                case "APPROVED": return "Success";
                case "BLOCKED":  return "Error";
                case "REVIEW":   return "Warning";
                default:         return "Information";
            }
        },

        /* ─── Misc ──────────────────────────────────────────────────── */

        confidencePct: function (nPassed, nTotal) {
            if (!nTotal) return "—";
            return (nPassed / nTotal * 100).toFixed(1) + "%";
        },

        booleanText: function (bValue) {
            if (bValue === true)  return "Yes";
            if (bValue === false) return "No";
            return "—";
        },

        dateText: function (sDate) {
            if (!sDate) return "";
            try { return new Date(sDate).toLocaleString(); } catch (e) { return sDate; }
        },

        timeAgo: function (sDate) {
            if (!sDate) return "—";
            try {
                var d = new Date(sDate);
                if (isNaN(d.getTime())) return "—";
                var sec = Math.floor((Date.now() - d.getTime()) / 1000);
                if (sec < 60)  return "just now";
                if (sec < 3600) return Math.floor(sec / 60) + " min ago";
                if (sec < 86400) return Math.floor(sec / 3600) + " hr ago";
                return d.toLocaleDateString();
            } catch (e) { return sDate; }
        }
    };
});
