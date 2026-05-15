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

    return Controller.extend("com.loadassurance.agent.controller.Scan", {

        formatter: formatter,

        /* ─── Lifecycle ─────────────────────────────────────────────── */

        onInit: function () {
            var oViewModel = new JSONModel({
                outboundDelivery: "",
                warehouse:        "",
                scanId:           null,
                totalHUs:         0,
                passedHUs:        0,
                reviewHUs:        0,
                failedHUs:        0,
                blockedHUs:       0,
                dispatchStatus:   "",
                verdictText:      "",
                aiSummary:        "",
                huResults:        [],
                huResultsAll:     [],
                exceptions:       [],
                exceptionCount:   0,
                busy:             false,
                giPosted:         false,
                giError:          "",
                reversalMessage:  "",
                loadingConfirmed: false,
                deliveryItems:    [],
                failureType:       "",
                dispatch:          null,
                wrongPallet:       null,
                wrongPalletSteps:  [],
                cancelPickMessage: "",
                cancelPickSuccess: false,
                loadingConfirmed: false,
                manualWeight:     "",
                weightUnit:       "LB",
                scaleReading:     "",
                scaleBusy:        false,
                scaleWeight:      null,
                chatBusy:         false,
                chatMessage:      "",
                // Vision state
                visionBusy:       false,
                visionFindings:   null,
                ewmSummary:       "",
                aiVerdict:        "",
                huLabelMatch:     null,
                itemCountMatch:   null,
                palletCondition:  "",
                palletImageName:  "",
                confidence:       "",
                // Warehouse Task result
                wtCreated:        false,
                wtNumber:         null,
                wtText:           "",
                // Agent pipeline
                agents: [
                    { agentId: "vision",     label: "Vision",     icon: "sap-icon://camera",          status: "WAITING", time: "", detail: "" },
                    { agentId: "knowledge",  label: "EWM",        icon: "sap-icon://database",        status: "WAITING", time: "", detail: "" },
                    { agentId: "decision",   label: "Decision",   icon: "sap-icon://ai",              status: "WAITING", time: "", detail: "" },
                    { agentId: "action",     label: "Action",     icon: "sap-icon://shipping-status", status: "WAITING", time: "", detail: "" },
                    { agentId: "resolution", label: "Resolution", icon: "sap-icon://wrench",          status: "WAITING", time: "", detail: "" }
                ]
            });
            this.getView().setModel(oViewModel, "scanView");

            var oChatModel = new JSONModel({ messages: [] });
            this.getView().setModel(oChatModel, "scanChat");

            UIComponent.getRouterFor(this)
                .getRoute("scan")
                .attachPatternMatched(this._onRouteMatched, this);

            // Restore saved scale IP
            this._scaleHost = localStorage.getItem("scaleIP") || null;
        },

        _onRouteMatched: function (oEvent) {
            var oArgs      = oEvent.getParameter("arguments");
            var sDelivery  = decodeURIComponent(oArgs.delivery);
            var sWarehouse = decodeURIComponent(oArgs.warehouse);
            this._scan(sDelivery, sWarehouse);
        },

        /* ─── Scan ──────────────────────────────────────────────────── */

        _scan: function (sDelivery, sWarehouse) {
            var oViewModel = this.getView().getModel("scanView");
            var oScaleWeight = oViewModel.getProperty("/scaleWeight");

            // Reset state (preserve scale weight and settings across re-scans)
            oViewModel.setData({
                outboundDelivery: sDelivery,
                warehouse:        sWarehouse,
                scanId:           null,
                totalHUs:         0,
                passedHUs:        0,
                reviewHUs:        0,
                failedHUs:        0,
                blockedHUs:       0,
                dispatchStatus:   "",
                verdictText:      "",
                aiSummary:        "",
                huResults:        [],
                huResultsAll:     [],
                exceptions:       [],
                exceptionCount:   0,
                busy:             true,
                giPosted:         false,
                giError:          "",
                reversalMessage:  "",
                loadingConfirmed: false,
                deliveryItems:    [],
                manualWeight:     oViewModel.getProperty("/manualWeight") || "",
                weightUnit:       oViewModel.getProperty("/weightUnit") || "LB",
                scaleReading:     oViewModel.getProperty("/scaleReading") || "",
                scaleBusy:        false,
                scaleWeight:      oScaleWeight,
                chatBusy:         false,
                chatMessage:      "",
                // Clear vision + reversal state on re-scan
                visionBusy:       false,
                visionFindings:   null,
                ewmSummary:       "",
                aiVerdict:        "",
                huLabelMatch:     null,
                itemCountMatch:   null,
                palletCondition:  "",
                palletImageName:  "",
                confidence:       "",
                wtCreated:        false,
                wtNumber:         null,
                wtText:           "",
                reversalMessage:  "",
                deliveryItems:    [],
                cancelPickMessage: "",
                cancelPickSuccess: false,
                failureType:      "",
                dispatch:         null,
                wrongPallet:      null,
                wrongPalletSteps: [],
                agents: [
                    { agentId: "vision",     label: "Vision",     icon: "sap-icon://camera",          status: "WAITING", time: "", detail: "" },
                    { agentId: "knowledge",  label: "EWM",        icon: "sap-icon://database",        status: "WAITING", time: "", detail: "" },
                    { agentId: "decision",   label: "Decision",   icon: "sap-icon://ai",              status: "WAITING", time: "", detail: "" },
                    { agentId: "action",     label: "Action",     icon: "sap-icon://shipping-status", status: "WAITING", time: "", detail: "" },
                    { agentId: "resolution", label: "Resolution", icon: "sap-icon://wrench",          status: "WAITING", time: "", detail: "" }
                ]
            });

            var oChatModel = this.getView().getModel("scanChat");
            if (oChatModel) { oChatModel.setProperty("/messages", []); }

            var oBody = { outboundDelivery: sDelivery, warehouse: sWarehouse };
            if (oScaleWeight && oScaleWeight.weight) {
                oBody.scaleWeight = oScaleWeight;
            }

            fetch(BASE + "/scanDelivery", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
                body:    JSON.stringify(oBody)
            })
            .then(function (oResp) {
                if (!oResp.ok) {
                    return oResp.json().then(function (oErr) {
                        throw new Error(oErr.error?.message || "Scan failed (HTTP " + oResp.status + ")");
                    });
                }
                return oResp.json();
            })
            .then(function (oData) {
                var v = oData.value || oData;
                var aExceptions = (v.exceptions || []).map(function (ex) {
                    return Object.assign({}, ex, { resolutionAction: "" });
                });
                var aHUs = v.huResults || [];
                oViewModel.setProperty("/busy",             false);
                oViewModel.setProperty("/scanId",           v.scanId);
                oViewModel.setProperty("/totalHUs",         v.totalHUs   || 0);
                oViewModel.setProperty("/passedHUs",        v.passedHUs  || 0);
                oViewModel.setProperty("/reviewHUs",        v.reviewHUs  || 0);
                oViewModel.setProperty("/failedHUs",        v.failedHUs  || 0);
                oViewModel.setProperty("/blockedHUs",       v.blockedHUs || 0);
                oViewModel.setProperty("/dispatchStatus",   v.dispatchStatus || "PENDING");
                console.log("[Scan] dispatchStatus:", v.dispatchStatus, "failureType:", v.failureType);
                oViewModel.setProperty("/aiSummary",        v.aiSummary  || "");
                oViewModel.setProperty("/huResults",        aHUs);
                oViewModel.setProperty("/huResultsAll",     aHUs);
                oViewModel.setProperty("/exceptions",       aExceptions);
                oViewModel.setProperty("/exceptionCount",   aExceptions.length);

                // Screen routing data
                var sFailureType = v.failureType || "NONE";
                oViewModel.setProperty("/failureType",   sFailureType);
                oViewModel.setProperty("/verdictText",   this._buildVerdictText(v));

                // Dispatch result (PASS)
                oViewModel.setProperty("/dispatch",      v.dispatch || null);

                // Wrong pallet result (OBD_MISMATCH)
                var oWP = v.wrongPallet || null;
                oViewModel.setProperty("/wrongPallet",   oWP);
                if (oWP) {
                    var aSteps = [];
                    try { aSteps = JSON.parse(oWP.manualInstructions || "[]"); } catch(e) {
                        aSteps = (oWP.manualInstructions || "").split("\n").filter(Boolean);
                    }
                    oViewModel.setProperty("/wrongPalletSteps", aSteps.map(function(s) { return { text: s, done: false }; }));
                } else {
                    oViewModel.setProperty("/wrongPalletSteps", []);
                }

                // Delivery items from ODO2 for cross-check
                oViewModel.setProperty("/deliveryItems", v.deliveryItems || []);

                // Share scan result on component model so Detail view can read it
                var oComp = this.getOwnerComponent();
                if (oComp) {
                    var oShared = oComp.getModel("scanData");
                    if (!oShared) {
                        oShared = new JSONModel({});
                        oComp.setModel(oShared, "scanData");
                    }
                    oShared.setData({
                        huResults:  aHUs,
                        exceptions: aExceptions,
                        outboundDelivery: v.outboundDelivery,
                        warehouse:        sWarehouse
                    });
                }

                // Seed copilot with scan context
                this._initChat(v);
            }.bind(this))
            .catch(function (oErr) {
                oViewModel.setProperty("/busy", false);
                MessageBox.error("Scan failed: " + oErr.message, { title: "Error" });
            });
        },

        _buildVerdictText: function (v) {
            var sStatus = v.dispatchStatus || "PENDING";
            var sBase;
            if (sStatus === "BLOCKED") {
                sBase = "Delivery " + v.outboundDelivery + " — BLOCKED. " +
                    v.failedHUs + " HU(s) failed validation.";
                if (v.blockedHUs) { sBase += " " + v.blockedHUs + " blocked."; }
            } else if (sStatus === "REVIEW") {
                sBase = "Delivery " + v.outboundDelivery + " — REVIEW required. " +
                    v.reviewHUs + " HU(s) need review before dispatch.";
            } else if (sStatus === "APPROVED") {
                sBase = "Delivery " + v.outboundDelivery + " approved for dispatch. Click Post Goods Issue to confirm in EWM.";
            } else {
                // PENDING
                sBase = "Delivery " + v.outboundDelivery + " — " +
                    v.passedHUs + "/" + v.totalHUs + " HUs passed. Ready for supervisor approval.";
            }
            return sBase;
        },

        /* ─── HU filter / navigation ────────────────────────────────── */

        onFilterHUs: function (oEvent) {
            var sQuery = (oEvent.getParameter("newValue") || "").toLowerCase();
            var oViewModel = this.getView().getModel("scanView");
            var aAll = oViewModel.getProperty("/huResultsAll") || [];
            oViewModel.setProperty("/huResults",
                sQuery ? aAll.filter(function (h) { return h.huId.toLowerCase().includes(sQuery); }) : aAll
            );
        },

        onRevalidateWeights: function () {
            var oViewModel  = this.getView().getModel("scanView");
            var aHUs        = oViewModel.getProperty("/huResultsAll") || [];
            var sDelivery   = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse  = oViewModel.getProperty("/warehouse");

            // Collect entered weights — only include HUs where user typed a value
            var aWeights = aHUs.map(function (h) {
                return { huId: h.huId, actualWeight: parseFloat(h.actualWeight) || 0 };
            }).filter(function (w) { return w.actualWeight > 0; });

            if (!aWeights.length) {
                MessageToast.show("Enter at least one actual weight before re-validating.");
                return;
            }

            oViewModel.setProperty("/busy", true);

            fetch(BASE + "/revalidateWeights", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ outboundDelivery: sDelivery, warehouse: sWarehouse, huWeights: aWeights })
            })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (e) { throw new Error(e.error?.message || "Revalidation failed"); });
                return r.json();
            })
            .then(function (oData) {
                oViewModel.setProperty("/busy", false);
                var v = oData.value || oData;
                // Update HU rows with new validation results
                var aUpdated = oViewModel.getProperty("/huResultsAll") || [];
                (v.huResults || []).forEach(function (r) {
                    var idx = aUpdated.findIndex(function (h) { return h.huId === r.huId; });
                    if (idx >= 0) { aUpdated[idx] = Object.assign({}, aUpdated[idx], r); }
                });
                oViewModel.setProperty("/huResultsAll", aUpdated);
                oViewModel.setProperty("/huResults",    aUpdated);
                oViewModel.setProperty("/passedHUs",    v.passedHUs  || 0);
                oViewModel.setProperty("/failedHUs",    v.failedHUs  || 0);
                oViewModel.setProperty("/reviewHUs",    v.reviewHUs  || 0);
                oViewModel.setProperty("/blockedHUs",   v.blockedHUs || 0);
                oViewModel.setProperty("/totalHUs",     v.totalHUs   || aUpdated.length);
                oViewModel.setProperty("/dispatchStatus", v.dispatchStatus || "PENDING");
                oViewModel.setProperty("/exceptions",   v.exceptions || []);
                oViewModel.setProperty("/aiSummary",    v.aiSummary  || "");
                MessageToast.show("Re-validation complete.");
            })
            .catch(function (e) {
                oViewModel.setProperty("/busy", false);
                MessageBox.error("Re-validation failed: " + e.message);
            });
        },

        onHUPress: function (oEvent) {
            var oViewModel = this.getView().getModel("scanView");
            var oSource = oEvent.getSource();
            var oItem = oSource;
            while (oItem && !oItem.getBindingContext("scanView")) { oItem = oItem.getParent(); }
            var oCtx = oItem && oItem.getBindingContext("scanView");
            if (!oCtx) { return; }
            var sHuId      = oCtx.getProperty("huId");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");
            UIComponent.getRouterFor(this).navTo("detail", {
                delivery:  encodeURIComponent(sDelivery),
                warehouse: encodeURIComponent(sWarehouse),
                huId:      encodeURIComponent(sHuId)
            });
        },

        /* ─── Approve / Block ───────────────────────────────────────── */

        onApproveDispatch: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            fetch(BASE + "/approveDispatch", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ outboundDelivery: sDelivery, warehouse: sWarehouse })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                oViewModel.setProperty("/dispatchStatus", "APPROVED");
                oViewModel.setProperty("/verdictText", v.message || "Dispatch approved.");
                // Update shipping readiness step flag from EWM result
                oViewModel.setProperty("/dispatch", {
                    step1_shippingReady:    v.shippingReadySet === true,
                    step2_loadingActivated: false,
                    step3_giPosted:         false,
                    complete:               false,
                    messages:               v.message || "",
                    errors:                 ""
                });
                sessionStorage.setItem("lastScanStatus", JSON.stringify({
                    delivery: sDelivery, warehouse: sWarehouse, status: "APPROVED"
                }));
                MessageToast.show(v.shippingReadySet ? "Shipping readiness set in EWM." : "Dispatch approved.");
            })
            .catch(function (e) { MessageBox.error("Approve failed: " + e.message); });
        },

        onBlockDispatch: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            MessageBox.confirm("Block dispatch for delivery " + sDelivery + "?", {
                title: "Block Dispatch",
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.YES) { return; }
                    var sReason = "Manually blocked by supervisor";
                    fetch(BASE + "/blockDispatch", {
                        method:  "POST",
                        headers: { "Content-Type": "application/json" },
                        body:    JSON.stringify({ outboundDelivery: sDelivery, warehouse: sWarehouse, reason: sReason })
                    })
                    .then(function (r) { return r.json(); })
                    .then(function (oData) {
                        oViewModel.setProperty("/dispatchStatus", "BLOCKED");
                        oViewModel.setProperty("/verdictText", (oData.value || oData).message || "Dispatch blocked.");
                        // Persist for Worklist refresh
                        sessionStorage.setItem("lastScanStatus", JSON.stringify({
                            delivery: sDelivery, warehouse: sWarehouse, status: "BLOCKED"
                        }));
                        MessageToast.show("Dispatch blocked.");
                    })
                    .catch(function (e) { MessageBox.error("Block failed: " + e.message); });
                }
            });
        },

        /* ─── Cancel Pick / Return to Storage ──────────────────────── */

        onCancelPick: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            // Get the first failed/blocked HU from the scan result to pass to the API
            var aHUResults = oViewModel.getProperty("/huResults") || [];
            var oFailedHU  = aHUResults.find(function (h) { return h.status !== "Passed"; }) || aHUResults[0];
            var sHuId      = oFailedHU ? (oFailedHU.huId || "") : "";
            var sStorageBin = oFailedHU ? (oFailedHU.storageBin || "") : "";

            MessageBox.confirm(
                "This will cancel the pick task in EWM and return HU " + (sHuId || "?") + " to storage.\n\nProceed for delivery " + sDelivery + "?",
                {
                    title:   "Cancel Pick / Return to Storage",
                    actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                    onClose: function (sAction) {
                        if (sAction !== MessageBox.Action.YES) { return; }

                        oViewModel.setProperty("/busy", true);

                        fetch(BASE + "/reverseShippingReadiness", {
                            method:  "POST",
                            headers: { "Content-Type": "application/json" },
                            body:    JSON.stringify({ outboundDelivery: sDelivery, warehouse: sWarehouse, huId: sHuId, storageBin: sStorageBin, reason: "Operator cancel pick" })
                        })
                        .then(function (r) { return r.json(); })
                        .then(function (oData) {
                            var v = oData.value || oData;
                            oViewModel.setProperty("/busy", false);
                            oViewModel.setProperty("/cancelPickSuccess", v.success || false);

                            if (v.success) {
                                oViewModel.setProperty("/cancelPickMessage",
                                    "Shipping readiness reversed. " + (v.nextStep || "Return task sent to RF gun."));
                                // Build step checklist from nextStep / manualSteps
                                var aSteps = [];
                                if (v.manualSteps && Array.isArray(v.manualSteps)) {
                                    aSteps = v.manualSteps;
                                } else if (v.nextStep) {
                                    aSteps = [
                                        "STOP — Do NOT load onto vehicle",
                                        v.nextStep,
                                        "Get correct HU for delivery " + sDelivery,
                                        "Bring correct HU to GI-ZONE and re-scan"
                                    ];
                                }
                                oViewModel.setProperty("/wrongPalletSteps", aSteps.map(function (s) { return { text: s, done: false }; }));
                                MessageToast.show("Shipping readiness reversed — follow the steps shown.");
                            } else {
                                oViewModel.setProperty("/cancelPickMessage",
                                    "Reversal failed: " + (v.message || "Unknown error. Use /SCWM/CANCPICK manually."));
                            }
                        })
                        .catch(function (oErr) {
                            oViewModel.setProperty("/busy", false);
                            oViewModel.setProperty("/cancelPickSuccess", false);
                            oViewModel.setProperty("/cancelPickMessage", "Error: " + oErr.message);
                        });
                    }
                }
            );
        },

        /* ─── Confirm Loading Complete ──────────────────────────────── */

        onConfirmLoading: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            MessageBox.confirm(
                "Confirm loading complete for delivery " + sDelivery + "?\n\nThis will activate loading and post Goods Issue in EWM.",
                {
                    title:   "Confirm Loading Complete",
                    actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                    emphasizedAction: MessageBox.Action.YES,
                    onClose: function (sAction) {
                        if (sAction !== MessageBox.Action.YES) { return; }

                        oViewModel.setProperty("/busy", true);

                        fetch(BASE + "/confirmLoading", {
                            method:  "POST",
                            headers: { "Content-Type": "application/json" },
                            body:    JSON.stringify({ outboundDelivery: sDelivery, warehouse: sWarehouse })
                        })
                        .then(function (r) { return r.json(); })
                        .then(function (oData) {
                            var v = oData.value || oData;
                            oViewModel.setProperty("/busy", false);
                            if (v.success) {
                                oViewModel.setProperty("/loadingConfirmed", true);
                                oViewModel.setProperty("/giPosted",         v.giPosted || true);
                                // Update dispatch step flags
                                oViewModel.setProperty("/dispatch/step1_shippingReady",    v.shippingReadinessSet || false);
                                oViewModel.setProperty("/dispatch/step2_loadingActivated", v.loadingActivated     || false);
                                oViewModel.setProperty("/dispatch/step3_giPosted",         v.giPosted             || false);
                                oViewModel.setProperty("/dispatch/complete",               true);
                                oViewModel.setProperty("/verdictText",
                                    "Loading confirmed for delivery " + sDelivery + ". GI posted. Vehicle cleared for departure.");
                                MessageToast.show("Loading complete — GI posted in EWM.");
                            } else {
                                oViewModel.setProperty("/giError", "Loading confirmation failed: " + (v.message || "Unknown error"));
                                MessageBox.warning(v.message || "Loading confirmation failed. Check EWM manually.", { title: "Loading Warning" });
                            }
                        })
                        .catch(function (oErr) {
                            oViewModel.setProperty("/busy", false);
                            MessageBox.error("Confirm loading failed: " + oErr.message);
                        });
                    }
                }
            );
        },

        /* ─── Post Goods Issue ──────────────────────────────────────── */

        onPostGoodsIssue: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            oViewModel.setProperty("/busy",    true);
            oViewModel.setProperty("/giError", "");

            fetch(BASE + "/postGoodsIssue", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ handlingUnitId: "", outboundDelivery: sDelivery, warehouseNumber: sWarehouse })
            })
            .then(function (oResp) {
                if (!oResp.ok) {
                    return oResp.json().then(function (e) {
                        throw new Error(e.error?.message || "GI failed (HTTP " + oResp.status + ")");
                    });
                }
                return oResp.json();
            })
            .then(function () {
                oViewModel.setProperty("/busy",     false);
                oViewModel.setProperty("/giPosted", true);
                oViewModel.setProperty("/verdictText",
                    "Goods Issue posted for delivery " + sDelivery + ".");
                MessageToast.show("Goods Issue posted successfully.");
            })
            .catch(function (oErr) {
                oViewModel.setProperty("/busy",    false);
                oViewModel.setProperty("/giError", "Goods Issue failed: " + oErr.message);
            });
        },

        /* ─── Resolve Exception ─────────────────────────────────────── */

        onResolveException: function (oEvent) {
            var oViewModel = this.getView().getModel("scanView");
            var sWarehouse = oViewModel.getProperty("/warehouse");
            var sScanId    = oViewModel.getProperty("/scanId");

            var oSource = oEvent.getSource();
            var oItem = oSource;
            while (oItem && !oItem.getBindingContext("scanView")) { oItem = oItem.getParent(); }
            var oCtx = oItem && oItem.getBindingContext("scanView");
            if (!oCtx) { return; }

            var sHuId         = oCtx.getProperty("huId");
            var sExceptionType = oCtx.getProperty("exceptionType");
            var sPath          = oCtx.getPath();

            oSource.setBusy(true);

            fetch(BASE + "/resolveException", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ huId: sHuId, warehouse: sWarehouse, exceptionType: sExceptionType, scanId: sScanId })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                oSource.setBusy(false);
                // Update the specific exception in the model
                oViewModel.setProperty(sPath + "/resolutionAction", v.resolutionAction || "Resolved.");
                MessageToast.show("AI resolution ready for " + sHuId);
            })
            .catch(function (oErr) {
                oSource.setBusy(false);
                MessageBox.error("Resolve failed: " + oErr.message);
            });
        },

        /* ─── Re-scan ───────────────────────────────────────────────── */

        onReScan: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");
            if (sDelivery && sWarehouse) {
                this._scan(sDelivery, sWarehouse);
            }
        },

        /* ─── Scan Pallet (NVIDIA Vision) ──────────────────────────── */

        _resetAgents: function () {
            return [
                { agentId: "vision",     label: "Vision",     icon: "sap-icon://camera",          status: "WAITING", time: "", detail: "" },
                { agentId: "knowledge",  label: "EWM",        icon: "sap-icon://database",        status: "WAITING", time: "", detail: "" },
                { agentId: "decision",   label: "Decision",   icon: "sap-icon://ai",              status: "WAITING", time: "", detail: "" },
                { agentId: "action",     label: "Action",     icon: "sap-icon://shipping-status", status: "WAITING", time: "", detail: "" },
                { agentId: "resolution", label: "Resolution", icon: "sap-icon://wrench",          status: "WAITING", time: "", detail: "" }
            ];
        },

        _setAgent: function (sId, sStatus, sTime, sDetail) {
            var oViewModel = this.getView().getModel("scanView");
            var aAgents = oViewModel.getProperty("/agents") || this._resetAgents();
            var idx = aAgents.findIndex(function (a) { return a.agentId === sId; });
            if (idx >= 0) {
                aAgents[idx].status = sStatus;
                if (sTime)   { aAgents[idx].time   = sTime; }
                if (sDetail) { aAgents[idx].detail = sDetail; }
                oViewModel.setProperty("/agents", aAgents.slice());
            }
        },

        _applyAgentResults: function (v) {
            // v contains agent pipeline results returned by orchestrateValidation
            // CDS returns them as JSON strings (LargeString) so we parse each one
            var that = this;
            var fmt = function (ms) { return ms ? (ms / 1000).toFixed(1) + "s" : ""; };
            var parse = function (x) {
                if (!x) return null;
                if (typeof x === "object") return x;
                try { return JSON.parse(x); } catch (e) { return null; }
            };

            var av = parse(v.agentVision);
            if (av) {
                that._setAgent("vision", av.agentStatus || "DONE", fmt(av.agentTime),
                    av.palletCondition ? "Condition: " + av.palletCondition : "");
            }
            var ak = parse(v.agentKnowledge);
            if (ak) {
                that._setAgent("knowledge", ak.agentStatus || "DONE", fmt(ak.agentTime),
                    ak.hus ? ak.hus.length + " HUs from EWM" : "");
            }
            var ad = parse(v.agentDecision);
            if (ad) {
                that._setAgent("decision", ad.agentStatus || "DONE", fmt(ad.agentTime),
                    ad.verdict ? "Verdict: " + ad.verdict + " (" + (ad.confidence || "") + ")" : "");
            }
            var aa = parse(v.agentAction);
            if (aa) {
                that._setAgent("action", aa.agentStatus || "DONE", fmt(aa.agentTime),
                    aa.success ? "GI Posted: " + (aa.confirmationNumber || "OK") : "Skipped");
            }
            var ar = parse(v.agentResolution);
            if (ar) {
                that._setAgent("resolution", ar.agentStatus || "DONE", fmt(ar.agentTime),
                    ar.failureReason ? ar.failureReason.substring(0, 60) : "");
            }
        },

        // Simulate progressive agent activation during the call (visual feedback)
        _startAgentAnimation: function () {
            var that = this;
            var oViewModel = this.getView().getModel("scanView");
            oViewModel.setProperty("/agents", this._resetAgents());
            // Agent1+2 start immediately (parallel)
            this._setAgent("vision",    "RUNNING", "", "");
            this._setAgent("knowledge", "RUNNING", "", "");
            // Agent3 starts after ~3s (approx vision time)
            this._agentTimer1 = setTimeout(function () {
                var aA = oViewModel.getProperty("/agents") || [];
                if (aA.find(function(a){return a.agentId==="vision";})?.status === "RUNNING") {
                    that._setAgent("vision",    "RUNNING", "", "Parsing image...");
                    that._setAgent("knowledge", "RUNNING", "", "Fetching EWM HUs...");
                }
            }, 2000);
            this._agentTimer2 = setTimeout(function () {
                var busy = oViewModel.getProperty("/visionBusy");
                if (busy) {
                    that._setAgent("decision", "RUNNING", "", "Cross-checking...");
                }
            }, 4000);
        },

        _stopAgentAnimation: function () {
            if (this._agentTimer1) { clearTimeout(this._agentTimer1); this._agentTimer1 = null; }
            if (this._agentTimer2) { clearTimeout(this._agentTimer2); this._agentTimer2 = null; }
        },

        onScanPallet: function () {
            // Trigger the hidden file input — opens camera on mobile, file browser on desktop
            var el = document.getElementById("palletFileInput");
            if (!el) {
                // Fallback: create the input dynamically if HTML control not ready
                el = document.createElement("input");
                el.type    = "file";
                el.accept  = "image/*";
                el.capture = "environment";
                document.body.appendChild(el);
            }
            el.onchange = this.onPalletImageChange.bind(this);
            el.value    = ""; // reset so same file can be re-selected
            el.click();
        },

        onScanPalletImage: function (oEvent) {
            var sHuId = oEvent.getSource().data("huId");
            var el = document.createElement("input");
            el.type    = "file";
            el.accept  = "image/*";
            el.capture = "environment";
            document.body.appendChild(el);
            el.onchange = function (e) {
                var oFile = e.target.files && e.target.files[0];
                if (!oFile) { document.body.removeChild(el); return; }
                var oViewModel = this.getView().getModel("scanView");
                var sWarehouse = oViewModel.getProperty("/warehouse");
                var sDelivery  = oViewModel.getProperty("/outboundDelivery");
                oViewModel.setProperty("/visionBusy", true);
                var reader = new FileReader();
                reader.onload = function (ev) {
                    var sBase64    = ev.target.result.split(",")[1];
                    var sMediaType = oFile.type || "image/jpeg";
                    fetch("/skills/scan-pallet", {
                        method:  "POST",
                        headers: { "Content-Type": "application/json" },
                        body:    JSON.stringify({ imageBase64: sBase64, mediaType: sMediaType, warehouse: sWarehouse, obdNumber: sDelivery })
                    })
                    .then(function (r) { return r.json(); })
                    .then(function (oData) {
                        oViewModel.setProperty("/visionBusy", false);
                        var v = oData.value || oData;
                        var aHUs = oViewModel.getProperty("/huResults") || [];
                        var oHU  = aHUs.find(function (h) { return h.huId === sHuId; });
                        if (oHU) {
                            oHU.labelStatus       = v.huLabelDetected ? "Detected" : "Not Found";
                            oHU.stackingCompliant = v.stackingCompliant;
                            oHU.issue             = (oHU.issue ? oHU.issue + " | " : "") + "Vision: " + (v.condition || "REVIEW") + (v.observations ? " — " + v.observations : "");
                            oViewModel.setProperty("/huResults", aHUs);
                        }
                        sap.m.MessageToast.show("Vision scan complete: " + (v.condition || "REVIEW") + " | Confidence: " + (v.confidence || "LOW"));
                    }.bind(this))
                    .catch(function (err) {
                        oViewModel.setProperty("/visionBusy", false);
                        sap.m.MessageBox.error("Vision scan failed: " + err.message);
                    });
                    document.body.removeChild(el);
                }.bind(this);
                reader.readAsDataURL(oFile);
            }.bind(this);
            el.click();
        },

        onPalletImageChange: function (oEvent) {
            var oFile = oEvent.target.files && oEvent.target.files[0];
            if (!oFile) { return; }

            var oViewModel = this.getView().getModel("scanView");
            var sDelivery  = oViewModel.getProperty("/outboundDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            oViewModel.setProperty("/visionBusy",      true);
            oViewModel.setProperty("/visionFindings",   null);
            oViewModel.setProperty("/aiVerdict",        "");
            oViewModel.setProperty("/ewmSummary",       "");
            oViewModel.setProperty("/huLabelMatch",     null);
            oViewModel.setProperty("/itemCountMatch",   null);
            oViewModel.setProperty("/palletCondition",  "");
            oViewModel.setProperty("/confidence",       "");
            oViewModel.setProperty("/palletImageName",  oFile.name);

            this._startAgentAnimation();

            var that = this;
            var reader = new FileReader();
            reader.onload = function (e) {
                var sDataUrl   = e.target.result;
                var sMediaType = oFile.type || "image/jpeg";
                var sBase64    = sDataUrl.split(",")[1];

                fetch("/api/scanPallet", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({
                        outboundDelivery: sDelivery,
                        warehouse:        sWarehouse,
                        imageBase64:      sBase64,
                        imageMediaType:   sMediaType
                    })
                })
                .then(function (r) {
                    if (!r.ok) {
                        return r.json().then(function (e) {
                            throw new Error(e.error?.message || "Vision scan failed (HTTP " + r.status + ")");
                        });
                    }
                    return r.json();
                })
                .then(function (oData) {
                    var v = oData.value || oData;
                    var oFindings = {};
                    try { oFindings = JSON.parse(v.visionFindings || "{}"); } catch (e) {}
                    that._stopAgentAnimation();
                    that._applyAgentResults(v);
                    oViewModel.setProperty("/visionBusy",      false);
                    oViewModel.setProperty("/visionFindings",   oFindings);
                    oViewModel.setProperty("/ewmSummary",       v.ewmSummary      || "");
                    oViewModel.setProperty("/aiVerdict",        v.aiVerdict       || "");
                    oViewModel.setProperty("/huLabelMatch",     v.huLabelMatch    != null ? v.huLabelMatch    : null);
                    oViewModel.setProperty("/itemCountMatch",   v.itemCountMatch  != null ? v.itemCountMatch  : null);
                    oViewModel.setProperty("/palletCondition",  v.palletCondition || "UNKNOWN");
                    oViewModel.setProperty("/confidence",       v.confidence      || "");
                    oViewModel.setProperty("/wtCreated",        v.wtCreated       || false);
                    oViewModel.setProperty("/wtNumber",         v.wtNumber        || null);
                    oViewModel.setProperty("/wtText",           v.wtText          || "");
                })
                .catch(function (oErr) {
                    that._stopAgentAnimation();
                    // Mark all RUNNING agents as FAILED
                    var aAgents = oViewModel.getProperty("/agents") || [];
                    aAgents.forEach(function (a, i) {
                        if (a.status === "RUNNING" || a.status === "WAITING") {
                            aAgents[i] = Object.assign({}, a, { status: "FAILED" });
                        }
                    });
                    oViewModel.setProperty("/agents", aAgents.slice());
                    oViewModel.setProperty("/visionBusy", false);
                    sap.m.MessageBox.error("Vision scan failed: " + oErr.message, { title: "Vision Error" });
                });
            };
            reader.readAsDataURL(oFile);
        },

        /* ─── Scale ─────────────────────────────────────────────────── */

        onManualWeightChange: function (oEvent) {
            var oViewModel = this.getView().getModel("scanView");
            var sVal = oEvent.getParameter("newValue") || oEvent.getParameter("value") || "";
            var fWeight = parseFloat(sVal);
            var sUnit   = oViewModel.getProperty("/weightUnit") || "LB";
            if (!isNaN(fWeight) && fWeight > 0) {
                oViewModel.setProperty("/scaleWeight",  { weight: fWeight, unit: sUnit, stable: true });
                oViewModel.setProperty("/scaleReading", fWeight.toFixed(3) + " " + sUnit);
            } else {
                oViewModel.setProperty("/scaleWeight",  null);
                oViewModel.setProperty("/scaleReading", "");
            }
        },

        onReadScale: function () {
            var oViewModel = this.getView().getModel("scanView");
            var that = this;

            // Show scale IP dialog if no host configured
            if (!this._scaleHost) {
                var sSaved = localStorage.getItem("scaleIP");
                if (sSaved) { this._scaleHost = sSaved; }
            }

            oViewModel.setProperty("/scaleBusy", true);

            var SCALE_CANDIDATES = ["scale","scale.local","teledoc","teledoc.local",
                "192.168.1.50","192.168.1.51","192.168.0.50","10.0.0.50","10.1.1.50"];

            var probeScale = function (sHost) {
                var PATHS = ["/weight","/api/weight","/api/v1/weight","/data"];
                var promises = PATHS.map(function (sPath) {
                    return fetch("http://" + sHost + sPath, { signal: AbortSignal.timeout(2000) })
                        .then(function (r) {
                            if (!r.ok) { return Promise.reject(); }
                            return r.json();
                        })
                        .then(function (d) {
                            var w = parseFloat(d.weight ?? d.value ?? d.Weight ?? d.Value);
                            if (isNaN(w)) { return Promise.reject(); }
                            return { host: sHost, weight: w,
                                     unit: (d.unit || d.Unit || "LB").toUpperCase(),
                                     stable: d.stable ?? d.Stable ?? true };
                        });
                });
                return Promise.any(promises).catch(function () { return null; });
            };

            var applyResult = function (oResult) {
                oViewModel.setProperty("/scaleBusy",   false);
                oViewModel.setProperty("/scaleWeight", { weight: oResult.weight, unit: oResult.unit, stable: oResult.stable });
                oViewModel.setProperty("/scaleReading", oResult.weight.toFixed(3) + " " + oResult.unit + (oResult.stable ? "" : " (unstable)"));
                oViewModel.setProperty("/manualWeight", String(oResult.weight));
                oViewModel.setProperty("/weightUnit",   oResult.unit);
                that._scaleHost = oResult.host;
                localStorage.setItem("scaleIP", oResult.host);
                MessageToast.show("Scale: " + oResult.weight.toFixed(3) + " " + oResult.unit);
                // Auto-rescan if delivery is already loaded
                if (oViewModel.getProperty("/outboundDelivery") && oResult.stable) {
                    that.onReScan();
                }
            };

            var onFail = function () {
                oViewModel.setProperty("/scaleBusy", false);
                MessageBox.warning(
                    "No scale found. Check that the scale is powered on and connected to the same network.\n\n" +
                    "You can also enter the weight manually in the Weight field.",
                    { title: "Scale Not Found" }
                );
            };

            if (this._scaleHost) {
                probeScale(this._scaleHost).then(function (r) {
                    if (r) { applyResult(r); return; }
                    that._scaleHost = null;
                    localStorage.removeItem("scaleIP");
                    // Try candidates as fallback
                    Promise.any(SCALE_CANDIDATES.map(function (h) {
                        return probeScale(h).then(function (r2) { return r2 ? r2 : Promise.reject(); });
                    })).then(applyResult).catch(onFail);
                });
            } else {
                Promise.any(SCALE_CANDIDATES.map(function (h) {
                    return probeScale(h).then(function (r) { return r ? r : Promise.reject(); });
                })).then(applyResult).catch(onFail);
            }
        },

        /* ─── AI Copilot Chat ───────────────────────────────────────── */

        _initChat: function (v) {
            var oChatModel = this.getView().getModel("scanChat");
            var sStatus = v.dispatchStatus === "APPROVED" ? "APPROVED ✓" : "BLOCKED ✗";
            oChatModel.setProperty("/messages", [{
                role:      "agent",
                text:      "Delivery " + v.outboundDelivery + " scanned — " + sStatus + ". " +
                           v.passedHUs + "/" + v.totalHUs + " HUs passed." +
                           (v.failedHUs  ? " " + v.failedHUs  + " failed."  : "") +
                           (v.blockedHUs ? " " + v.blockedHUs + " blocked." : "") +
                           " Ask me anything about this shipment.",
                timestamp: this._chatNow()
            }]);
        },

        _buildChatContext: function () {
            var oVM = this.getView().getModel("scanView");
            return "Delivery=" + oVM.getProperty("/outboundDelivery") +
                "; Warehouse=" + oVM.getProperty("/warehouse") +
                "; Status=" + oVM.getProperty("/dispatchStatus") +
                "; Total=" + oVM.getProperty("/totalHUs") +
                "; Passed=" + oVM.getProperty("/passedHUs") +
                "; Failed=" + oVM.getProperty("/failedHUs") +
                "; Blocked=" + oVM.getProperty("/blockedHUs");
        },

        _appendChat: function (sRole, sText) {
            var oChatModel = this.getView().getModel("scanChat");
            var aMessages  = oChatModel.getProperty("/messages") || [];
            aMessages.push({ role: sRole, text: sText, timestamp: this._chatNow() });
            oChatModel.setProperty("/messages", aMessages);
        },

        _chatNow: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        },

        onSendChat: function () {
            var oViewModel = this.getView().getModel("scanView");
            var sMsg = (oViewModel.getProperty("/chatMessage") || "").trim();
            if (!sMsg) { return; }

            this._appendChat("user", sMsg);
            oViewModel.setProperty("/chatMessage", "");
            oViewModel.setProperty("/chatBusy",    true);

            var sContext = this._buildChatContext();
            var that = this;

            fetch(BASE + "/chat", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ message: sMsg, context: sContext })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                that._appendChat("agent", v.reply || "AI temporarily unavailable.");
                oViewModel.setProperty("/chatBusy", false);
            })
            .catch(function (oErr) {
                that._appendChat("agent", "Error: " + oErr.message);
                oViewModel.setProperty("/chatBusy", false);
            });
        },

        onChatSuggestion: function (oEvent) {
            var sText = oEvent.getSource().getText();
            this.getView().getModel("scanView").setProperty("/chatMessage", sText);
            this.onSendChat();
        },

        /* ─── Navigation ────────────────────────────────────────────── */

        onNavBack: function () {
            UIComponent.getRouterFor(this).navTo("worklist", {}, true);
        }

    });
});
