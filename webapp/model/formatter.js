sap.ui.define([], function () {
    "use strict";

    return {

        /**
         * Returns a ValueState string based on the HU validation status.
         * @param {string} sStatus  "Passed" | "Failed" | "Review" | undefined
         * @returns {string} sap.ui.core.ValueState
         */
        statusState: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "Success";
                case "Failed": return "Error";
                case "Review": return "Warning";
                default:       return "None";
            }
        },

        /**
         * Returns a MessageStrip / highlight indicator value for list rows.
         * @param {string} sStatus
         * @returns {string} sap.ui.core.IndicationColor or ValueState string for highlight
         */
        statusHighlight: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "Success";
                case "Failed": return "Error";
                case "Review": return "Warning";
                default:       return "None";
            }
        },

        /**
         * Returns an sap-icon URI for each status.
         * @param {string} sStatus
         * @returns {string}
         */
        statusIcon: function (sStatus) {
            switch (sStatus) {
                case "Passed": return "sap-icon://accept";
                case "Failed": return "sap-icon://error";
                case "Review": return "sap-icon://warning";
                default:       return "sap-icon://status-inactive";
            }
        },

        /**
         * Returns a ValueState based on severity level.
         * @param {string} sSeverity  "Critical" | "High" | "Medium" | "Low"
         * @returns {string} sap.ui.core.ValueState
         */
        severityState: function (sSeverity) {
            switch (sSeverity) {
                case "Critical": return "Error";
                case "High":     return "Error";
                case "Medium":   return "Warning";
                case "Low":      return "Success";
                default:         return "None";
            }
        },

        /**
         * Computes the weight delta as a formatted percentage string, e.g. "+3.2%" or "-1.0%".
         * @param {number} nExpected
         * @param {number} nActual
         * @returns {string}
         */
        weightDeltaText: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) {
                return "N/A";
            }
            var fDeltaPct = ((nActual - nExpected) / nExpected) * 100;
            var sSign = fDeltaPct >= 0 ? "+" : "";
            return sSign + fDeltaPct.toFixed(1) + "%";
        },

        /**
         * Returns the raw numeric delta percentage for ObjectNumber binding.
         * @param {number} nExpected
         * @param {number} nActual
         * @returns {number|null}
         */
        weightDeltaNumber: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) {
                return null;
            }
            return parseFloat(((nActual - nExpected) / nExpected * 100).toFixed(2));
        },

        /**
         * Returns a ValueState based on the magnitude of the weight delta.
         * ±5 % threshold: >5% → Error, >2% → Warning, else → Success.
         * @param {number} nExpected
         * @param {number} nActual
         * @returns {string}
         */
        weightDeltaState: function (nExpected, nActual) {
            if (nExpected == null || nActual == null || nExpected === 0) {
                return "None";
            }
            var fAbsPct = Math.abs((nActual - nExpected) / nExpected * 100);
            if (fAbsPct > 5)  { return "Error"; }
            if (fAbsPct > 2)  { return "Warning"; }
            return "Success";
        },

        /**
         * Maps label scan status to ValueState.
         * @param {string} sLabelStatus  "OK" | "Missing" | "Damaged"
         * @returns {string}
         */
        labelStatusState: function (sLabelStatus) {
            switch (sLabelStatus) {
                case "OK":      return "Success";
                case "Damaged": return "Warning";
                case "Missing": return "Error";
                default:        return "None";
            }
        },

        /**
         * Converts a boolean compliance flag to a human-readable string.
         * @param {boolean} bValue
         * @returns {string}
         */
        booleanText: function (bValue) {
            if (bValue === true)  { return "Compliant"; }
            if (bValue === false) { return "Non-Compliant"; }
            return "Unknown";
        },

        /**
         * Converts a boolean compliance flag to a ValueState.
         * @param {boolean} bValue
         * @returns {string}
         */
        booleanState: function (bValue) {
            if (bValue === true)  { return "Success"; }
            if (bValue === false) { return "Error"; }
            return "None";
        }
    };
});
