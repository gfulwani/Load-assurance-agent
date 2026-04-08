sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "com/loadassurance/agent/model/formatter",
    "sap/m/MessageToast"
], function (Controller, JSONModel, Filter, FilterOperator, formatter, MessageToast) {
    "use strict";

    return Controller.extend("com.loadassurance.agent.controller.Worklist", {

        formatter: formatter,

        /* ============================================================
         * Lifecycle
         * ============================================================ */

        onInit: function () {
            // View model for counts, filter state, busy flag
            var oViewModel = new JSONModel({
                totalCount:          0,
                passedCount:         0,
                failedCount:         0,
                reviewCount:         0,
                avgConfidence:       "—",
                tableItemCount:      0,
                selectedStatusFilter: "All",
                busy:                false,
                delay:               0
            });
            this.getView().setModel(oViewModel, "worklistView");

            // Bind the table and attach to the route matched event so the
            // KPI counts are refreshed whenever the user navigates back.
            var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
            oRouter.getRoute("worklist").attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function () {
            this._refreshKPIs();
        },

        /* ============================================================
         * Table / binding
         * ============================================================ */

        /**
         * Called after the table's list binding has been updated.
         * Reads the count from the binding and keeps the title in sync.
         * @param {sap.ui.base.Event} oEvent
         */
        onTableUpdateFinished: function (oEvent) {
            var oViewModel = this.getView().getModel("worklistView");
            var nTotal     = oEvent.getParameter("total");

            oViewModel.setProperty("/tableItemCount", nTotal || 0);
            this._refreshKPIs();
        },

        /* ============================================================
         * Search & Filter
         * ============================================================ */

        /**
         * Live-search handler: filters the table by huID or outboundDelivery.
         * @param {sap.ui.base.Event} oEvent
         */
        onSearch: function (oEvent) {
            var sQuery   = oEvent.getParameter("query") || oEvent.getParameter("newValue") || "";
            var aFilters = [];

            if (sQuery.trim()) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("huID",             FilterOperator.Contains, sQuery),
                        new Filter("outboundDelivery", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                }));
            }

            // Merge with the active status filter
            var sStatus = this.getView().getModel("worklistView").getProperty("/selectedStatusFilter");
            if (sStatus && sStatus !== "All") {
                aFilters.push(new Filter("status", FilterOperator.EQ, sStatus));
            }

            var oTable   = this.byId("huTable");
            var oBinding = oTable.getBinding("items");
            oBinding.filter(aFilters);
        },

        /**
         * SegmentedButton handler — filters the table by validation status.
         * @param {sap.ui.base.Event} oEvent
         */
        onStatusFilterChange: function (oEvent) {
            var sKey     = oEvent.getParameter("item").getKey();
            var oViewModel = this.getView().getModel("worklistView");
            oViewModel.setProperty("/selectedStatusFilter", sKey);

            var aFilters = [];
            if (sKey !== "All") {
                aFilters.push(new Filter("status", FilterOperator.EQ, sKey));
            }

            var oTable   = this.byId("huTable");
            var oBinding = oTable.getBinding("items");
            oBinding.filter(aFilters);
        },

        /* ============================================================
         * Refresh
         * ============================================================ */

        /**
         * Refresh button handler — refreshes the OData V4 list binding.
         */
        onRefresh: function () {
            var oTable   = this.byId("huTable");
            var oBinding = oTable.getBinding("items");

            if (oBinding.hasPendingChanges()) {
                oBinding.resetChanges();
            }
            oBinding.refresh();
            MessageToast.show("Refreshing handling units…");
        },

        /* ============================================================
         * Navigation
         * ============================================================ */

        /**
         * ColumnListItem press handler — navigate to the Detail page
         * passing the HU's ID as a route parameter.
         * @param {sap.ui.base.Event} oEvent
         */
        onItemPress: function (oEvent) {
            var oItem    = oEvent.getSource();
            // getBindingContext works on ColumnListItem or ObjectIdentifier
            var oContext = oItem.getBindingContext
                ? oItem.getBindingContext()
                : oItem.getParent().getBindingContext();

            if (!oContext) {
                // Fallback: traverse up to the ColumnListItem
                var oParent = oItem.getParent();
                while (oParent && !oParent.getBindingContext) {
                    oParent = oParent.getParent();
                }
                oContext = oParent && oParent.getBindingContext();
            }

            if (oContext) {
                var sHuID = oContext.getProperty("huID");
                var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
                oRouter.navTo("detail", {
                    huID: encodeURIComponent(sHuID)
                });
            }
        },

        /* ============================================================
         * KPI helpers
         * ============================================================ */

        /**
         * Reads HandlingUnits with $apply=aggregate to derive KPI values.
         * Falls back to client-side counting when aggregate is unavailable.
         * @private
         */
        _refreshKPIs: function () {
            var oViewModel = this.getView().getModel("worklistView");
            var oModel     = this.getOwnerComponent().getModel();

            // Use a lightweight $filter+$count approach for each status
            var aStatusFetches = ["Passed", "Failed", "Review"].map(function (sStatus) {
                return new Promise(function (resolve) {
                    var oListBinding = oModel.bindList("/HandlingUnits", null, null, [
                        new Filter("status", FilterOperator.EQ, sStatus)
                    ]);
                    oListBinding.requestContexts(0, 1).then(function () {
                        resolve({ status: sStatus, count: oListBinding.getLength() });
                    }).catch(function () {
                        resolve({ status: sStatus, count: 0 });
                    });
                });
            });

            // Total + avg confidence via table binding length
            var oTable   = this.byId("huTable");
            var oBinding = oTable && oTable.getBinding("items");

            Promise.all(aStatusFetches).then(function (aResults) {
                var nPassed = 0, nFailed = 0, nReview = 0;
                aResults.forEach(function (r) {
                    if (r.status === "Passed") { nPassed = r.count; }
                    if (r.status === "Failed") { nFailed = r.count; }
                    if (r.status === "Review") { nReview = r.count; }
                });
                var nTotal = nPassed + nFailed + nReview;

                oViewModel.setProperty("/passedCount", nPassed);
                oViewModel.setProperty("/failedCount", nFailed);
                oViewModel.setProperty("/reviewCount", nReview);
                oViewModel.setProperty("/totalCount",  nTotal);

                if (oBinding) {
                    oViewModel.setProperty("/tableItemCount", oBinding.getLength() || nTotal);
                }

                // Average confidence: fetch all records for the KPI
                oModel.bindList("/HandlingUnits", null, null, null, {
                    $select: "validationConfidence"
                }).requestContexts(0, 200).then(function (aContexts) {
                    var nSum = aContexts.reduce(function (s, ctx) {
                        return s + (ctx.getProperty("validationConfidence") || 0);
                    }, 0);
                    var sAvg = aContexts.length
                        ? (nSum / aContexts.length).toFixed(1)
                        : "—";
                    oViewModel.setProperty("/avgConfidence", sAvg);
                }).catch(function () { /* silent */ });

            }).catch(function () { /* silent */ });
        },

        /* ============================================================
         * Formatters (proxy, so they are accessible via `.formatter.x`)
         * ============================================================ */

        /**
         * Proxy to the standalone formatter module so that XML views can
         * bind formatters with the `.formatter.` prefix through `this`.
         */
        _formatWeightDelta: function (nExpected, nActual) {
            return formatter.weightDeltaText(nExpected, nActual);
        }

    });
});
