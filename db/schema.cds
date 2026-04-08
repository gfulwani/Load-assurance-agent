namespace load.assurance;

using { cuid, managed } from '@sap/cds/common';

entity HandlingUnit : cuid {
    huID                 : String(20);
    outboundDelivery     : String(20);
    expectedWeight       : Decimal(10,3);
    actualWeight         : Decimal(10,3);
    status               : String(10) enum { Passed; Failed; Review };
    severity             : String(10) enum { Critical; High; Medium; Low };
    issueDescription     : String(500);
    validationConfidence : Decimal(5,2);
    validationResults    : Composition of many ValidationResult on validationResults.hu = $self;
    aiRecommendations    : Composition of many AIRecommendation on aiRecommendations.hu = $self;
}

entity ValidationResult : cuid {
    hu                 : Association to HandlingUnit;
    labelStatus        : String(10) enum { OK; Missing; Damaged };
    stackingCompliance : Boolean;
    weightDelta        : Decimal(10,3);
    aiInsight          : String(1000);
    rootCause          : String(500);
    recommendedAction  : String(500);
}

entity AIRecommendation : cuid {
    hu                 : Association to HandlingUnit;
    recommendationType : String(20) enum { Weight; Label; Stacking; Route };
    confidence         : Decimal(5,2);
    reasoning          : String(1000);
    action             : String(500);
    priority           : Integer;
    createdAt          : DateTime;
}
