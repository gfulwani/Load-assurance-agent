sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/UIComponent",
    "com/loadassurance/agent/model/formatter",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (Controller, JSONModel, UIComponent, formatter, MessageBox, MessageToast) {
    "use strict";

    var BASE = "/api";

    return Controller.extend("com.loadassurance.agent.controller.Detail", {

        formatter: formatter,

        /* ─── Lifecycle ─────────────────────────────────────────────── */

        onInit: function () {
            var oViewModel = new JSONModel({
                huId:             "",
                outboundDelivery: "",
                warehouse:        "",
                storageBin:       "",
                huStatus:         "",
                expectedWeight:   null,
                actualWeight:     null,
                weightUnit:       "LB",
                weightDelta:      null,
                weightDeltaPct:   null,
                weightPassed:     null,
                isBlocked:        false,
                isClosed:         false,
                passed:           null,
                issue:            "",
                resolutionAction: "",
                exceptionType:    "",
                // UI state
                busy:             false,
                resolving:        false,
                chatBusy:         false,
                chatMessage:      ""
            });
            this.getView().setModel(oViewModel, "detailView");

            var oChatModel = new JSONModel({ messages: [] });
            this.getView().setModel(oChatModel, "chat");

            UIComponent.getRouterFor(this)
                .getRoute("detail")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        /* ─── Route handling ────────────────────────────────────────── */

        _onRouteMatched: function (oEvent) {
            var oArgs      = oEvent.getParameter("arguments");
            var sHuId      = decodeURIComponent(oArgs.huId);
            var sDelivery  = decodeURIComponent(oArgs.delivery);
            var sWarehouse = decodeURIComponent(oArgs.warehouse);

            // Try to read HU data from the Scan view's model (already in memory)
            this._loadFromScanModel(sHuId, sDelivery, sWarehouse);

            // Reset chat
            this.getView().getModel("chat").setProperty("/messages", [{
                role: "agent",
                text: "I'm ready to help with HU " + sHuId + ". Ask me anything.",
                timestamp: this._now()
            }]);
        },

        /**
         * Reads the HU record from the shared component scanData model
         * (set by the Scan controller after a successful scan).
         */
        _loadFromScanModel: function (sHuId, sDelivery, sWarehouse) {
            var oViewModel = this.getView().getModel("detailView");
            oViewModel.setProperty("/huId",             sHuId);
            oViewModel.setProperty("/outboundDelivery", sDelivery);
            oViewModel.setProperty("/warehouse",        sWarehouse);

            try {
                var oComp      = this.getOwnerComponent();
                var oShared    = oComp && oComp.getModel("scanData");
                if (oShared) {
                    var aHUs = oShared.getProperty("/huResults") || [];
                    var oHU  = aHUs.find(function (h) { return h.huId === sHuId; });
                    if (oHU) {
                        this._applyHUData(oHU, sDelivery, sWarehouse);
                        // Also carry over exception resolution state
                        var aExcs = oShared.getProperty("/exceptions") || [];
                        var oExc  = aExcs.find(function (e) { return e.huId === sHuId; });
                        if (oExc && oExc.resolutionAction) {
                            oViewModel.setProperty("/resolutionAction", oExc.resolutionAction);
                        }
                        return;
                    }
                }
            } catch (e) { /* silent */ }
        },

        _applyHUData: function (oHU, sDelivery, sWarehouse) {
            var oVM = this.getView().getModel("detailView");
            oVM.setProperty("/huId",             oHU.huId);
            oVM.setProperty("/outboundDelivery", sDelivery);
            oVM.setProperty("/warehouse",        sWarehouse);
            oVM.setProperty("/storageBin",       oHU.storageBin       || "");
            oVM.setProperty("/huStatus",         oHU.huStatus         || "");
            oVM.setProperty("/expectedWeight",   oHU.expectedWeight   || 0);
            oVM.setProperty("/actualWeight",     oHU.actualWeight     || 0);
            oVM.setProperty("/weightUnit",       oHU.weightUnit       || "LB");
            oVM.setProperty("/weightDelta",      oHU.weightDelta      || 0);
            oVM.setProperty("/weightDeltaPct",   oHU.weightDeltaPct   || 0);
            oVM.setProperty("/weightPassed",     !!oHU.weightPassed);
            oVM.setProperty("/isBlocked",        !!oHU.isBlocked);
            oVM.setProperty("/isClosed",         !!oHU.isClosed);
            oVM.setProperty("/passed",           !!oHU.passed);
            oVM.setProperty("/issue",            oHU.issue            || "");
            oVM.setProperty("/exceptionType",    oHU.isBlocked ? "BLOCKED" : "WEIGHT");
        },

        /* ─── AI Resolve ────────────────────────────────────────────── */

        onResolveException: function () {
            var oViewModel     = this.getView().getModel("detailView");
            var sHuId          = oViewModel.getProperty("/huId");
            var sWarehouse     = oViewModel.getProperty("/warehouse");
            var sExceptionType = oViewModel.getProperty("/exceptionType") || "WEIGHT";

            oViewModel.setProperty("/resolving", true);

            fetch(BASE + "/resolveException", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ huId: sHuId, warehouse: sWarehouse, exceptionType: sExceptionType })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                oViewModel.setProperty("/resolving",        false);
                oViewModel.setProperty("/resolutionAction", v.resolutionAction || "Resolved.");
                MessageToast.show("AI resolution ready.");
            })
            .catch(function (oErr) {
                oViewModel.setProperty("/resolving", false);
                MessageBox.error("Resolve failed: " + oErr.message);
            });
        },

        /* ─── AI Chat ───────────────────────────────────────────────── */

        onSendChat: function () {
            var oViewModel = this.getView().getModel("detailView");
            var sMsg       = (oViewModel.getProperty("/chatMessage") || "").trim();
            if (!sMsg) { return; }

            this._appendChat("user", sMsg);
            oViewModel.setProperty("/chatMessage", "");
            oViewModel.setProperty("/chatBusy",    true);

            var sContext = this._buildContext(oViewModel);

            fetch(BASE + "/chat", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ message: sMsg, context: sContext })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                this._appendChat("agent", v.reply || "AI unavailable.");
                oViewModel.setProperty("/chatBusy", false);
            }.bind(this))
            .catch(function (oErr) {
                this._appendChat("agent", "Error: " + oErr.message);
                oViewModel.setProperty("/chatBusy", false);
            }.bind(this));
        },

        onSuggestion: function (oEvent) {
            var sText = oEvent.getSource().getText();
            this.getView().getModel("detailView").setProperty("/chatMessage", sText);
            this.onSendChat();
        },

        /* ─── Navigation ────────────────────────────────────────────── */

        onNavBack: function () {
            var oViewModel = this.getView().getModel("detailView");
            UIComponent.getRouterFor(this).navTo("scan", {
                delivery:  encodeURIComponent(oViewModel.getProperty("/outboundDelivery")),
                warehouse: encodeURIComponent(oViewModel.getProperty("/warehouse"))
            }, true);
        },

        /* ─── Helpers ───────────────────────────────────────────────── */

        _appendChat: function (sRole, sText) {
            var oChatModel = this.getView().getModel("chat");
            var aMessages  = oChatModel.getProperty("/messages") || [];
            aMessages.push({ role: sRole, text: sText, timestamp: this._now() });
            oChatModel.setProperty("/messages", aMessages);
        },

        _buildContext: function (oVM) {
            return "HU=" + oVM.getProperty("/huId") +
                "; Delivery=" + oVM.getProperty("/outboundDelivery") +
                "; Warehouse=" + oVM.getProperty("/warehouse") +
                "; Status=" + (oVM.getProperty("/passed") ? "PASSED" : "FAILED") +
                "; Expected=" + oVM.getProperty("/expectedWeight") +
                "; Actual=" + oVM.getProperty("/actualWeight") +
                "; Blocked=" + oVM.getProperty("/isBlocked") +
                "; Issue=" + oVM.getProperty("/issue");
        },

        _now: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }

    });
});
