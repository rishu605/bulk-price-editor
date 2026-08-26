/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type AnchorStagedUploadsCreateMutationVariables = AdminTypes.Exact<{
  input: Array<AdminTypes.StagedUploadInput> | AdminTypes.StagedUploadInput;
}>;


export type AnchorStagedUploadsCreateMutation = { stagedUploadsCreate?: AdminTypes.Maybe<{ stagedTargets?: AdminTypes.Maybe<Array<(
      Pick<AdminTypes.StagedMediaUploadTarget, 'url' | 'resourceUrl'>
      & { parameters: Array<Pick<AdminTypes.StagedUploadParameter, 'name' | 'value'>> }
    )>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorBulkOperationRunMutationMutationVariables = AdminTypes.Exact<{
  mutation: AdminTypes.Scalars['String']['input'];
  stagedUploadPath: AdminTypes.Scalars['String']['input'];
}>;


export type AnchorBulkOperationRunMutationMutation = { bulkOperationRunMutation?: AdminTypes.Maybe<{ bulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status' | 'url' | 'partialDataUrl' | 'objectCount'>>, userErrors: Array<Pick<AdminTypes.BulkMutationUserError, 'field' | 'message'>> }> };

export type AnchorCurrentBulkOperationQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type AnchorCurrentBulkOperationQuery = { currentBulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status' | 'url' | 'partialDataUrl' | 'objectCount' | 'errorCode'>> };

export type AnchorPriceListFixedPricesAddMutationVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  prices: Array<AdminTypes.PriceListPriceInput> | AdminTypes.PriceListPriceInput;
}>;


export type AnchorPriceListFixedPricesAddMutation = { priceListFixedPricesAdd?: AdminTypes.Maybe<{ prices?: AdminTypes.Maybe<Array<{ variant: Pick<AdminTypes.ProductVariant, 'id'>, price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, compareAtPrice?: AdminTypes.Maybe<Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>> }>>, userErrors: Array<Pick<AdminTypes.PriceListPriceUserError, 'field' | 'message' | 'code'>> }> };

export type AnchorPriceListFixedPricesDeleteMutationVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  variantIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorPriceListFixedPricesDeleteMutation = { priceListFixedPricesDelete?: AdminTypes.Maybe<(
    Pick<AdminTypes.PriceListFixedPricesDeletePayload, 'deletedFixedPriceVariantIds'>
    & { userErrors: Array<Pick<AdminTypes.PriceListPriceUserError, 'field' | 'message' | 'code'>> }
  )> };

export type AnchorPriceListDerivedPricesQueryVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  query: AdminTypes.Scalars['String']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type AnchorPriceListDerivedPricesQuery = { priceList?: AdminTypes.Maybe<(
    Pick<AdminTypes.PriceList, 'currency'>
    & { prices: { nodes: Array<{ variant: Pick<AdminTypes.ProductVariant, 'id'>, price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type AnchorContextualPricesQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
  context: AdminTypes.ContextualPricingContext;
}>;


export type AnchorContextualPricesQuery = { nodes: Array<AdminTypes.Maybe<(
    Pick<AdminTypes.ProductVariant, 'id'>
    & { contextualPricing: { price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, compareAtPrice?: AdminTypes.Maybe<Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>> } }
  )>> };

export type AnchorPriceListParentQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorPriceListParentQuery = { priceList?: AdminTypes.Maybe<(
    Pick<AdminTypes.PriceList, 'id' | 'currency'>
    & { parent?: AdminTypes.Maybe<{ adjustment: Pick<AdminTypes.PriceListAdjustment, 'type' | 'value'>, settings: Pick<AdminTypes.PriceListAdjustmentSettings, 'compareAtMode'> }>, fixed: { nodes: Array<{ variant: Pick<AdminTypes.ProductVariant, 'id'> }> } }
  )> };

export type AnchorPriceListUpdateMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  input: AdminTypes.PriceListUpdateInput;
}>;


export type AnchorPriceListUpdateMutation = { priceListUpdate?: AdminTypes.Maybe<{ priceList?: AdminTypes.Maybe<(
      Pick<AdminTypes.PriceList, 'id'>
      & { parent?: AdminTypes.Maybe<{ adjustment: Pick<AdminTypes.PriceListAdjustment, 'type' | 'value'> }> }
    )>, userErrors: Array<Pick<AdminTypes.PriceListUserError, 'field' | 'message' | 'code'>> }> };

export type AnchorProductVariantsBulkUpdateMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type AnchorProductVariantsBulkUpdateMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'price' | 'compareAtPrice'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message' | 'code'>> }> };

export type AnchorVariantPricesQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorVariantPricesQuery = { nodes: Array<AdminTypes.Maybe<Pick<AdminTypes.ProductVariant, 'id' | 'price' | 'compareAtPrice'>>> };

export type AnchorProbeVariantsBulkUpdateMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type AnchorProbeVariantsBulkUpdateMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message'>> }> };

export type AnchorProbeBulkQueryMutationVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type AnchorProbeBulkQueryMutation = { bulkOperationRunQuery?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.BulkOperationUserError, 'field' | 'message'>> }> };

export type AnchorProbeBulkMutationMutationVariables = AdminTypes.Exact<{
  mutation: AdminTypes.Scalars['String']['input'];
  stagedUploadPath: AdminTypes.Scalars['String']['input'];
}>;


export type AnchorProbeBulkMutationMutation = { bulkOperationRunMutation?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.BulkMutationUserError, 'field' | 'message'>> }> };

export type AnchorProbeStagedUploadsMutationVariables = AdminTypes.Exact<{
  input: Array<AdminTypes.StagedUploadInput> | AdminTypes.StagedUploadInput;
}>;


export type AnchorProbeStagedUploadsMutation = { stagedUploadsCreate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorProbePriceListCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.PriceListCreateInput;
}>;


export type AnchorProbePriceListCreateMutation = { priceListCreate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.PriceListUserError, 'field' | 'message'>> }> };

export type AnchorProbePriceListUpdateMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  input: AdminTypes.PriceListUpdateInput;
}>;


export type AnchorProbePriceListUpdateMutation = { priceListUpdate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.PriceListUserError, 'field' | 'message'>> }> };

export type AnchorProbeFixedPricesAddMutationVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  prices: Array<AdminTypes.PriceListPriceInput> | AdminTypes.PriceListPriceInput;
}>;


export type AnchorProbeFixedPricesAddMutation = { priceListFixedPricesAdd?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.PriceListPriceUserError, 'field' | 'message'>> }> };

export type AnchorProbeFixedPricesDeleteMutationVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  variantIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorProbeFixedPricesDeleteMutation = { priceListFixedPricesDelete?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.PriceListPriceUserError, 'field' | 'message'>> }> };

export type AnchorProbeQuantityPricingMutationVariables = AdminTypes.Exact<{
  priceListId: AdminTypes.Scalars['ID']['input'];
  input: AdminTypes.QuantityPricingByVariantUpdateInput;
}>;


export type AnchorProbeQuantityPricingMutation = { quantityPricingByVariantUpdate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.QuantityPricingByVariantUserError, 'field' | 'message'>> }> };

export type AnchorProbeCatalogCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.CatalogCreateInput;
}>;


export type AnchorProbeCatalogCreateMutation = { catalogCreate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.CatalogUserError, 'field' | 'message'>> }> };

export type AnchorProbeCatalogUpdateMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  input: AdminTypes.CatalogUpdateInput;
}>;


export type AnchorProbeCatalogUpdateMutation = { catalogUpdate?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.CatalogUserError, 'field' | 'message'>> }> };

export type AnchorProbeTagsAddMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type AnchorProbeTagsAddMutation = { tagsAdd?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorProbeTagsRemoveMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type AnchorProbeTagsRemoveMutation = { tagsRemove?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorProbeMarketsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type AnchorProbeMarketsQuery = { markets: { nodes: Array<Pick<AdminTypes.Market, 'id'>> } };

export type AnchorProbeCompaniesQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type AnchorProbeCompaniesQuery = { companies: { nodes: Array<Pick<AdminTypes.Company, 'id'>> } };

export type AnchorProductTagsQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorProductTagsQuery = { nodes: Array<AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'tags'>>> };

export type AnchorTagsAddMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type AnchorTagsAddMutation = { tagsAdd?: AdminTypes.Maybe<{ node?: AdminTypes.Maybe<Pick<AdminTypes.AbandonedCheckout, 'id'> | Pick<AdminTypes.AbandonedCheckoutLineItem, 'id'> | Pick<AdminTypes.Abandonment, 'id'> | Pick<AdminTypes.AddAllProductsOperation, 'id'> | Pick<AdminTypes.AdditionalFee, 'id'> | Pick<AdminTypes.App, 'id'> | Pick<AdminTypes.AppCatalog, 'id'> | Pick<AdminTypes.AppCredit, 'id'> | Pick<AdminTypes.AppInstallation, 'id'> | Pick<AdminTypes.AppPurchaseOneTime, 'id'> | Pick<AdminTypes.AppRevenueAttributionRecord, 'id'> | Pick<AdminTypes.AppSubscription, 'id'> | Pick<AdminTypes.AppUsageRecord, 'id'> | Pick<AdminTypes.Article, 'id'> | Pick<AdminTypes.BasicEvent, 'id'> | Pick<AdminTypes.Blog, 'id'> | Pick<AdminTypes.BulkOperation, 'id'> | Pick<AdminTypes.BusinessEntity, 'id'> | Pick<AdminTypes.CalculatedOrder, 'id'> | Pick<AdminTypes.CartTransform, 'id'> | Pick<AdminTypes.CashDrawer, 'id'> | Pick<AdminTypes.CashManagementCustomReasonCode, 'id'> | Pick<AdminTypes.CashManagementDefaultReasonCode, 'id'> | Pick<AdminTypes.CashManagementSystemReasonCode, 'id'> | Pick<AdminTypes.CashTrackingAdjustment, 'id'> | Pick<AdminTypes.CashTrackingSession, 'id'> | Pick<AdminTypes.CatalogCsvOperation, 'id'> | Pick<AdminTypes.Channel, 'id'> | Pick<AdminTypes.ChannelDefinition, 'id'> | Pick<AdminTypes.ChannelInformation, 'id'> | Pick<AdminTypes.CheckoutAndAccountsConfiguration, 'id'> | Pick<AdminTypes.CheckoutAndAccountsConfigurationOverride, 'id'> | Pick<AdminTypes.CheckoutProfile, 'id'> | Pick<AdminTypes.Collection, 'id'> | Pick<AdminTypes.CollectionConditionsSource, 'id'> | Pick<AdminTypes.CollectionSubCollectionsSource, 'id'> | Pick<AdminTypes.Comment, 'id'> | Pick<AdminTypes.CommentEvent, 'id'> | Pick<AdminTypes.Company, 'id'> | Pick<AdminTypes.CompanyAddress, 'id'> | Pick<AdminTypes.CompanyContact, 'id'> | Pick<AdminTypes.CompanyContactRole, 'id'> | Pick<AdminTypes.CompanyContactRoleAssignment, 'id'> | Pick<AdminTypes.CompanyLocation, 'id'> | Pick<AdminTypes.CompanyLocationCatalog, 'id'> | Pick<AdminTypes.CompanyLocationStaffMemberAssignment, 'id'> | Pick<AdminTypes.ConsentPolicy, 'id'> | Pick<AdminTypes.CurrencyExchangeAdjustment, 'id'> | Pick<AdminTypes.Customer, 'id'> | Pick<AdminTypes.CustomerAccountAppExtensionPage, 'id'> | Pick<AdminTypes.CustomerAccountNativePage, 'id'> | Pick<AdminTypes.CustomerPaymentMethod, 'id'> | Pick<AdminTypes.CustomerSegmentMembersQuery, 'id'> | Pick<AdminTypes.CustomerVisit, 'id'> | Pick<AdminTypes.DeliveryCarrierService, 'id'> | Pick<AdminTypes.DeliveryCondition, 'id'> | Pick<AdminTypes.DeliveryCountry, 'id'> | Pick<AdminTypes.DeliveryCustomization, 'id'> | Pick<AdminTypes.DeliveryLocationGroup, 'id'> | Pick<AdminTypes.DeliveryMethod, 'id'> | Pick<AdminTypes.DeliveryMethodDefinition, 'id'> | Pick<AdminTypes.DeliveryParticipant, 'id'> | Pick<AdminTypes.DeliveryProfile, 'id'> | Pick<AdminTypes.DeliveryProfileItem, 'id'> | Pick<AdminTypes.DeliveryPromiseParticipant, 'id'> | Pick<AdminTypes.DeliveryPromiseProvider, 'id'> | Pick<AdminTypes.DeliveryProvince, 'id'> | Pick<AdminTypes.DeliveryRateDefinition, 'id'> | Pick<AdminTypes.DeliveryZone, 'id'> | Pick<AdminTypes.DiscountAutomaticBxgy, 'id'> | Pick<AdminTypes.DiscountAutomaticNode, 'id'> | Pick<AdminTypes.DiscountCodeNode, 'id'> | Pick<AdminTypes.DiscountNode, 'id'> | Pick<AdminTypes.DiscountRedeemCodeBulkCreation, 'id'> | Pick<AdminTypes.Domain, 'id'> | Pick<AdminTypes.DraftOrder, 'id'> | Pick<AdminTypes.DraftOrderLineItem, 'id'> | Pick<AdminTypes.DraftOrderTag, 'id'> | Pick<AdminTypes.Duty, 'id'> | Pick<AdminTypes.ExchangeLineItem, 'id'> | Pick<AdminTypes.ExchangeV2, 'id'> | Pick<AdminTypes.ExternalVideo, 'id'> | Pick<AdminTypes.Fulfillment, 'id'> | Pick<AdminTypes.FulfillmentConstraintRule, 'id'> | Pick<AdminTypes.FulfillmentEvent, 'id'> | Pick<AdminTypes.FulfillmentHold, 'id'> | Pick<AdminTypes.FulfillmentLineItem, 'id'> | Pick<AdminTypes.FulfillmentOrder, 'id'> | Pick<AdminTypes.FulfillmentOrderDestination, 'id'> | Pick<AdminTypes.FulfillmentOrderLineItem, 'id'> | Pick<AdminTypes.FulfillmentOrderMerchantRequest, 'id'> | Pick<AdminTypes.GenericFile, 'id'> | Pick<AdminTypes.GiftCard, 'id'> | Pick<AdminTypes.GiftCardCashOutTransaction, 'id'> | Pick<AdminTypes.GiftCardCreditTransaction, 'id'> | Pick<AdminTypes.GiftCardDebitTransaction, 'id'> | Pick<AdminTypes.IdentityProviderSubject, 'id'> | Pick<AdminTypes.InventoryAdjustmentGroup, 'id'> | Pick<AdminTypes.InventoryItem, 'id'> | Pick<AdminTypes.InventoryItemMeasurement, 'id'> | Pick<AdminTypes.InventoryLevel, 'id'> | Pick<AdminTypes.InventoryQuantity, 'id'> | Pick<AdminTypes.InventoryShipment, 'id'> | Pick<AdminTypes.InventoryShipmentLineItem, 'id'> | Pick<AdminTypes.InventoryTransfer, 'id'> | Pick<AdminTypes.InventoryTransferLineItem, 'id'> | Pick<AdminTypes.LineItem, 'id'> | Pick<AdminTypes.LineItemGroup, 'id'> | Pick<AdminTypes.Location, 'id'> | Pick<AdminTypes.MailingAddress, 'id'> | Pick<AdminTypes.Market, 'id'> | Pick<AdminTypes.MarketCatalog, 'id'> | Pick<AdminTypes.MarketRegionCountry, 'id'> | Pick<AdminTypes.MarketRegionSubdivision, 'id'> | Pick<AdminTypes.MarketWebPresence, 'id'> | Pick<AdminTypes.MarketingActivity, 'id'> | Pick<AdminTypes.MarketingEvent, 'id'> | Pick<AdminTypes.MediaImage, 'id'> | Pick<AdminTypes.Menu, 'id'> | Pick<AdminTypes.Metafield, 'id'> | Pick<AdminTypes.MetafieldDefinition, 'id'> | Pick<AdminTypes.Metaobject, 'id'> | Pick<AdminTypes.MetaobjectDefinition, 'id'> | Pick<AdminTypes.Model3d, 'id'> | Pick<AdminTypes.OnlineStoreTheme, 'id'> | Pick<AdminTypes.Order, 'id'> | Pick<AdminTypes.OrderAdjustment, 'id'> | Pick<AdminTypes.OrderAttributionDefinition, 'id'> | Pick<AdminTypes.OrderCreateMandatePaymentJobResult, 'id'> | Pick<AdminTypes.OrderDisputeSummary, 'id'> | Pick<AdminTypes.OrderEditSession, 'id'> | Pick<AdminTypes.OrderTransaction, 'id'> | Pick<AdminTypes.Page, 'id'> | Pick<AdminTypes.PaymentCustomization, 'id'> | Pick<AdminTypes.PaymentMandate, 'id'> | Pick<AdminTypes.PaymentSchedule, 'id'> | Pick<AdminTypes.PaymentTerms, 'id'> | Pick<AdminTypes.PaymentTermsTemplate, 'id'> | Pick<AdminTypes.PointOfSaleDevice, 'id'> | Pick<AdminTypes.PointOfSaleDevicePaymentSession, 'id'> | Pick<AdminTypes.PriceList, 'id'> | Pick<AdminTypes.PriceRule, 'id'> | Pick<AdminTypes.PriceRuleDiscountCode, 'id'> | Pick<AdminTypes.Product, 'id'> | Pick<AdminTypes.ProductBundleOperation, 'id'> | Pick<AdminTypes.ProductDeleteOperation, 'id'> | Pick<AdminTypes.ProductDuplicateOperation, 'id'> | Pick<AdminTypes.ProductFeed, 'id'> | Pick<AdminTypes.ProductOption, 'id'> | Pick<AdminTypes.ProductOptionValue, 'id'> | Pick<AdminTypes.ProductSetOperation, 'id'> | Pick<AdminTypes.ProductTaxonomyNode, 'id'> | Pick<AdminTypes.ProductVariant, 'id'> | Pick<AdminTypes.ProductVariantComponent, 'id'> | Pick<AdminTypes.Publication, 'id'> | Pick<AdminTypes.PublicationResourceOperation, 'id'> | Pick<AdminTypes.QuantityPriceBreak, 'id'> | Pick<AdminTypes.Refund, 'id'> | Pick<AdminTypes.RefundShippingLine, 'id'> | Pick<AdminTypes.Return, 'id'> | Pick<AdminTypes.ReturnLineItem, 'id'> | Pick<AdminTypes.ReturnReasonDefinition, 'id'> | Pick<AdminTypes.ReturnableFulfillment, 'id'> | Pick<AdminTypes.ReverseDelivery, 'id'> | Pick<AdminTypes.ReverseDeliveryLineItem, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrder, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrderDisposition, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrderLineItem, 'id'> | Pick<AdminTypes.SaleAdditionalFee, 'id'> | Pick<AdminTypes.SavedSearch, 'id'> | Pick<AdminTypes.ScriptTag, 'id'> | Pick<AdminTypes.Segment, 'id'> | Pick<AdminTypes.SellingPlan, 'id'> | Pick<AdminTypes.SellingPlanGroup, 'id'> | Pick<AdminTypes.ServerPixel, 'id'> | Pick<AdminTypes.ShippingLabel, 'id'> | Pick<AdminTypes.ShippingLabelPurchaseResult, 'id'> | Pick<AdminTypes.Shop, 'id'> | Pick<AdminTypes.ShopAddress, 'id'> | Pick<AdminTypes.ShopPolicy, 'id'> | Pick<AdminTypes.ShopifyPaymentsAccount, 'id'> | Pick<AdminTypes.ShopifyPaymentsBalanceTransaction, 'id'> | Pick<AdminTypes.ShopifyPaymentsBankAccount, 'id'> | Pick<AdminTypes.ShopifyPaymentsDispute, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeEvidence, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeFileUpload, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeFulfillment, 'id'> | Pick<AdminTypes.ShopifyPaymentsPayout, 'id'> | Pick<AdminTypes.StaffMember, 'id'> | Pick<AdminTypes.StandardMetafieldDefinitionTemplate, 'id'> | Pick<AdminTypes.StoreCreditAccount, 'id'> | Pick<AdminTypes.StoreCreditAccountCreditTransaction, 'id'> | Pick<AdminTypes.StoreCreditAccountDebitRevertTransaction, 'id'> | Pick<AdminTypes.StoreCreditAccountDebitTransaction, 'id'> | Pick<AdminTypes.StorefrontAccessToken, 'id'> | Pick<AdminTypes.SubscriptionBillingAttempt, 'id'> | Pick<AdminTypes.SubscriptionContract, 'id'> | Pick<AdminTypes.SubscriptionDraft, 'id'> | Pick<AdminTypes.TaxonomyAttribute, 'id'> | Pick<AdminTypes.TaxonomyCategory, 'id'> | Pick<AdminTypes.TaxonomyChoiceListAttribute, 'id'> | Pick<AdminTypes.TaxonomyMeasurementAttribute, 'id'> | Pick<AdminTypes.TaxonomyValue, 'id'> | Pick<AdminTypes.TenderTransaction, 'id'> | Pick<AdminTypes.TransactionFee, 'id'> | Pick<AdminTypes.UnverifiedReturnLineItem, 'id'> | Pick<AdminTypes.UrlRedirect, 'id'> | Pick<AdminTypes.UrlRedirectImport, 'id'> | Pick<AdminTypes.Validation, 'id'> | Pick<AdminTypes.Video, 'id'> | Pick<AdminTypes.WebPixel, 'id'> | Pick<AdminTypes.WebhookSubscription, 'id'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorTagsRemoveMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type AnchorTagsRemoveMutation = { tagsRemove?: AdminTypes.Maybe<{ node?: AdminTypes.Maybe<Pick<AdminTypes.AbandonedCheckout, 'id'> | Pick<AdminTypes.AbandonedCheckoutLineItem, 'id'> | Pick<AdminTypes.Abandonment, 'id'> | Pick<AdminTypes.AddAllProductsOperation, 'id'> | Pick<AdminTypes.AdditionalFee, 'id'> | Pick<AdminTypes.App, 'id'> | Pick<AdminTypes.AppCatalog, 'id'> | Pick<AdminTypes.AppCredit, 'id'> | Pick<AdminTypes.AppInstallation, 'id'> | Pick<AdminTypes.AppPurchaseOneTime, 'id'> | Pick<AdminTypes.AppRevenueAttributionRecord, 'id'> | Pick<AdminTypes.AppSubscription, 'id'> | Pick<AdminTypes.AppUsageRecord, 'id'> | Pick<AdminTypes.Article, 'id'> | Pick<AdminTypes.BasicEvent, 'id'> | Pick<AdminTypes.Blog, 'id'> | Pick<AdminTypes.BulkOperation, 'id'> | Pick<AdminTypes.BusinessEntity, 'id'> | Pick<AdminTypes.CalculatedOrder, 'id'> | Pick<AdminTypes.CartTransform, 'id'> | Pick<AdminTypes.CashDrawer, 'id'> | Pick<AdminTypes.CashManagementCustomReasonCode, 'id'> | Pick<AdminTypes.CashManagementDefaultReasonCode, 'id'> | Pick<AdminTypes.CashManagementSystemReasonCode, 'id'> | Pick<AdminTypes.CashTrackingAdjustment, 'id'> | Pick<AdminTypes.CashTrackingSession, 'id'> | Pick<AdminTypes.CatalogCsvOperation, 'id'> | Pick<AdminTypes.Channel, 'id'> | Pick<AdminTypes.ChannelDefinition, 'id'> | Pick<AdminTypes.ChannelInformation, 'id'> | Pick<AdminTypes.CheckoutAndAccountsConfiguration, 'id'> | Pick<AdminTypes.CheckoutAndAccountsConfigurationOverride, 'id'> | Pick<AdminTypes.CheckoutProfile, 'id'> | Pick<AdminTypes.Collection, 'id'> | Pick<AdminTypes.CollectionConditionsSource, 'id'> | Pick<AdminTypes.CollectionSubCollectionsSource, 'id'> | Pick<AdminTypes.Comment, 'id'> | Pick<AdminTypes.CommentEvent, 'id'> | Pick<AdminTypes.Company, 'id'> | Pick<AdminTypes.CompanyAddress, 'id'> | Pick<AdminTypes.CompanyContact, 'id'> | Pick<AdminTypes.CompanyContactRole, 'id'> | Pick<AdminTypes.CompanyContactRoleAssignment, 'id'> | Pick<AdminTypes.CompanyLocation, 'id'> | Pick<AdminTypes.CompanyLocationCatalog, 'id'> | Pick<AdminTypes.CompanyLocationStaffMemberAssignment, 'id'> | Pick<AdminTypes.ConsentPolicy, 'id'> | Pick<AdminTypes.CurrencyExchangeAdjustment, 'id'> | Pick<AdminTypes.Customer, 'id'> | Pick<AdminTypes.CustomerAccountAppExtensionPage, 'id'> | Pick<AdminTypes.CustomerAccountNativePage, 'id'> | Pick<AdminTypes.CustomerPaymentMethod, 'id'> | Pick<AdminTypes.CustomerSegmentMembersQuery, 'id'> | Pick<AdminTypes.CustomerVisit, 'id'> | Pick<AdminTypes.DeliveryCarrierService, 'id'> | Pick<AdminTypes.DeliveryCondition, 'id'> | Pick<AdminTypes.DeliveryCountry, 'id'> | Pick<AdminTypes.DeliveryCustomization, 'id'> | Pick<AdminTypes.DeliveryLocationGroup, 'id'> | Pick<AdminTypes.DeliveryMethod, 'id'> | Pick<AdminTypes.DeliveryMethodDefinition, 'id'> | Pick<AdminTypes.DeliveryParticipant, 'id'> | Pick<AdminTypes.DeliveryProfile, 'id'> | Pick<AdminTypes.DeliveryProfileItem, 'id'> | Pick<AdminTypes.DeliveryPromiseParticipant, 'id'> | Pick<AdminTypes.DeliveryPromiseProvider, 'id'> | Pick<AdminTypes.DeliveryProvince, 'id'> | Pick<AdminTypes.DeliveryRateDefinition, 'id'> | Pick<AdminTypes.DeliveryZone, 'id'> | Pick<AdminTypes.DiscountAutomaticBxgy, 'id'> | Pick<AdminTypes.DiscountAutomaticNode, 'id'> | Pick<AdminTypes.DiscountCodeNode, 'id'> | Pick<AdminTypes.DiscountNode, 'id'> | Pick<AdminTypes.DiscountRedeemCodeBulkCreation, 'id'> | Pick<AdminTypes.Domain, 'id'> | Pick<AdminTypes.DraftOrder, 'id'> | Pick<AdminTypes.DraftOrderLineItem, 'id'> | Pick<AdminTypes.DraftOrderTag, 'id'> | Pick<AdminTypes.Duty, 'id'> | Pick<AdminTypes.ExchangeLineItem, 'id'> | Pick<AdminTypes.ExchangeV2, 'id'> | Pick<AdminTypes.ExternalVideo, 'id'> | Pick<AdminTypes.Fulfillment, 'id'> | Pick<AdminTypes.FulfillmentConstraintRule, 'id'> | Pick<AdminTypes.FulfillmentEvent, 'id'> | Pick<AdminTypes.FulfillmentHold, 'id'> | Pick<AdminTypes.FulfillmentLineItem, 'id'> | Pick<AdminTypes.FulfillmentOrder, 'id'> | Pick<AdminTypes.FulfillmentOrderDestination, 'id'> | Pick<AdminTypes.FulfillmentOrderLineItem, 'id'> | Pick<AdminTypes.FulfillmentOrderMerchantRequest, 'id'> | Pick<AdminTypes.GenericFile, 'id'> | Pick<AdminTypes.GiftCard, 'id'> | Pick<AdminTypes.GiftCardCashOutTransaction, 'id'> | Pick<AdminTypes.GiftCardCreditTransaction, 'id'> | Pick<AdminTypes.GiftCardDebitTransaction, 'id'> | Pick<AdminTypes.IdentityProviderSubject, 'id'> | Pick<AdminTypes.InventoryAdjustmentGroup, 'id'> | Pick<AdminTypes.InventoryItem, 'id'> | Pick<AdminTypes.InventoryItemMeasurement, 'id'> | Pick<AdminTypes.InventoryLevel, 'id'> | Pick<AdminTypes.InventoryQuantity, 'id'> | Pick<AdminTypes.InventoryShipment, 'id'> | Pick<AdminTypes.InventoryShipmentLineItem, 'id'> | Pick<AdminTypes.InventoryTransfer, 'id'> | Pick<AdminTypes.InventoryTransferLineItem, 'id'> | Pick<AdminTypes.LineItem, 'id'> | Pick<AdminTypes.LineItemGroup, 'id'> | Pick<AdminTypes.Location, 'id'> | Pick<AdminTypes.MailingAddress, 'id'> | Pick<AdminTypes.Market, 'id'> | Pick<AdminTypes.MarketCatalog, 'id'> | Pick<AdminTypes.MarketRegionCountry, 'id'> | Pick<AdminTypes.MarketRegionSubdivision, 'id'> | Pick<AdminTypes.MarketWebPresence, 'id'> | Pick<AdminTypes.MarketingActivity, 'id'> | Pick<AdminTypes.MarketingEvent, 'id'> | Pick<AdminTypes.MediaImage, 'id'> | Pick<AdminTypes.Menu, 'id'> | Pick<AdminTypes.Metafield, 'id'> | Pick<AdminTypes.MetafieldDefinition, 'id'> | Pick<AdminTypes.Metaobject, 'id'> | Pick<AdminTypes.MetaobjectDefinition, 'id'> | Pick<AdminTypes.Model3d, 'id'> | Pick<AdminTypes.OnlineStoreTheme, 'id'> | Pick<AdminTypes.Order, 'id'> | Pick<AdminTypes.OrderAdjustment, 'id'> | Pick<AdminTypes.OrderAttributionDefinition, 'id'> | Pick<AdminTypes.OrderCreateMandatePaymentJobResult, 'id'> | Pick<AdminTypes.OrderDisputeSummary, 'id'> | Pick<AdminTypes.OrderEditSession, 'id'> | Pick<AdminTypes.OrderTransaction, 'id'> | Pick<AdminTypes.Page, 'id'> | Pick<AdminTypes.PaymentCustomization, 'id'> | Pick<AdminTypes.PaymentMandate, 'id'> | Pick<AdminTypes.PaymentSchedule, 'id'> | Pick<AdminTypes.PaymentTerms, 'id'> | Pick<AdminTypes.PaymentTermsTemplate, 'id'> | Pick<AdminTypes.PointOfSaleDevice, 'id'> | Pick<AdminTypes.PointOfSaleDevicePaymentSession, 'id'> | Pick<AdminTypes.PriceList, 'id'> | Pick<AdminTypes.PriceRule, 'id'> | Pick<AdminTypes.PriceRuleDiscountCode, 'id'> | Pick<AdminTypes.Product, 'id'> | Pick<AdminTypes.ProductBundleOperation, 'id'> | Pick<AdminTypes.ProductDeleteOperation, 'id'> | Pick<AdminTypes.ProductDuplicateOperation, 'id'> | Pick<AdminTypes.ProductFeed, 'id'> | Pick<AdminTypes.ProductOption, 'id'> | Pick<AdminTypes.ProductOptionValue, 'id'> | Pick<AdminTypes.ProductSetOperation, 'id'> | Pick<AdminTypes.ProductTaxonomyNode, 'id'> | Pick<AdminTypes.ProductVariant, 'id'> | Pick<AdminTypes.ProductVariantComponent, 'id'> | Pick<AdminTypes.Publication, 'id'> | Pick<AdminTypes.PublicationResourceOperation, 'id'> | Pick<AdminTypes.QuantityPriceBreak, 'id'> | Pick<AdminTypes.Refund, 'id'> | Pick<AdminTypes.RefundShippingLine, 'id'> | Pick<AdminTypes.Return, 'id'> | Pick<AdminTypes.ReturnLineItem, 'id'> | Pick<AdminTypes.ReturnReasonDefinition, 'id'> | Pick<AdminTypes.ReturnableFulfillment, 'id'> | Pick<AdminTypes.ReverseDelivery, 'id'> | Pick<AdminTypes.ReverseDeliveryLineItem, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrder, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrderDisposition, 'id'> | Pick<AdminTypes.ReverseFulfillmentOrderLineItem, 'id'> | Pick<AdminTypes.SaleAdditionalFee, 'id'> | Pick<AdminTypes.SavedSearch, 'id'> | Pick<AdminTypes.ScriptTag, 'id'> | Pick<AdminTypes.Segment, 'id'> | Pick<AdminTypes.SellingPlan, 'id'> | Pick<AdminTypes.SellingPlanGroup, 'id'> | Pick<AdminTypes.ServerPixel, 'id'> | Pick<AdminTypes.ShippingLabel, 'id'> | Pick<AdminTypes.ShippingLabelPurchaseResult, 'id'> | Pick<AdminTypes.Shop, 'id'> | Pick<AdminTypes.ShopAddress, 'id'> | Pick<AdminTypes.ShopPolicy, 'id'> | Pick<AdminTypes.ShopifyPaymentsAccount, 'id'> | Pick<AdminTypes.ShopifyPaymentsBalanceTransaction, 'id'> | Pick<AdminTypes.ShopifyPaymentsBankAccount, 'id'> | Pick<AdminTypes.ShopifyPaymentsDispute, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeEvidence, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeFileUpload, 'id'> | Pick<AdminTypes.ShopifyPaymentsDisputeFulfillment, 'id'> | Pick<AdminTypes.ShopifyPaymentsPayout, 'id'> | Pick<AdminTypes.StaffMember, 'id'> | Pick<AdminTypes.StandardMetafieldDefinitionTemplate, 'id'> | Pick<AdminTypes.StoreCreditAccount, 'id'> | Pick<AdminTypes.StoreCreditAccountCreditTransaction, 'id'> | Pick<AdminTypes.StoreCreditAccountDebitRevertTransaction, 'id'> | Pick<AdminTypes.StoreCreditAccountDebitTransaction, 'id'> | Pick<AdminTypes.StorefrontAccessToken, 'id'> | Pick<AdminTypes.SubscriptionBillingAttempt, 'id'> | Pick<AdminTypes.SubscriptionContract, 'id'> | Pick<AdminTypes.SubscriptionDraft, 'id'> | Pick<AdminTypes.TaxonomyAttribute, 'id'> | Pick<AdminTypes.TaxonomyCategory, 'id'> | Pick<AdminTypes.TaxonomyChoiceListAttribute, 'id'> | Pick<AdminTypes.TaxonomyMeasurementAttribute, 'id'> | Pick<AdminTypes.TaxonomyValue, 'id'> | Pick<AdminTypes.TenderTransaction, 'id'> | Pick<AdminTypes.TransactionFee, 'id'> | Pick<AdminTypes.UnverifiedReturnLineItem, 'id'> | Pick<AdminTypes.UrlRedirect, 'id'> | Pick<AdminTypes.UrlRedirectImport, 'id'> | Pick<AdminTypes.Validation, 'id'> | Pick<AdminTypes.Video, 'id'> | Pick<AdminTypes.WebPixel, 'id'> | Pick<AdminTypes.WebhookSubscription, 'id'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorCatalogBulkQueryMutationVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type AnchorCatalogBulkQueryMutation = { bulkOperationRunQuery?: AdminTypes.Maybe<{ bulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status'>>, userErrors: Array<Pick<AdminTypes.BulkOperationUserError, 'field' | 'message'>> }> };

export type AnchorCurrentBulkQueryQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type AnchorCurrentBulkQueryQuery = { currentBulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status' | 'url' | 'partialDataUrl' | 'objectCount' | 'errorCode'>> };

export type AnchorCatalogPageQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type AnchorCatalogPageQuery = { products: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Product, 'id' | 'title' | 'vendor' | 'productType' | 'status' | 'tags' | 'updatedAt'>
      & { collections: { nodes: Array<Pick<AdminTypes.Collection, 'id'>> }, variants: { nodes: Array<(
          Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'sku' | 'barcode' | 'price' | 'compareAtPrice' | 'inventoryQuantity'>
          & { inventoryItem: { unitCost?: AdminTypes.Maybe<Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>> } }
        )> } }
    )> } };

export type AnchorShopCurrencyQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type AnchorShopCurrencyQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode' | 'ianaTimezone'> };

export type AnchorFlowTriggerReceiveMutationVariables = AdminTypes.Exact<{
  handle: AdminTypes.Scalars['String']['input'];
  payload: AdminTypes.Scalars['JSON']['input'];
}>;


export type AnchorFlowTriggerReceiveMutation = { flowTriggerReceive?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type AnchorPriceListsQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type AnchorPriceListsQuery = { priceLists: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.PriceList, 'id' | 'name' | 'currency'>
      & { parent?: AdminTypes.Maybe<{ adjustment: Pick<AdminTypes.PriceListAdjustment, 'type' | 'value'> }>, catalog?: AdminTypes.Maybe<(
        { __typename: 'AppCatalog' }
        & Pick<AdminTypes.AppCatalog, 'id' | 'title'>
      ) | (
        { __typename: 'CompanyLocationCatalog' }
        & Pick<AdminTypes.CompanyLocationCatalog, 'id' | 'title'>
      ) | (
        { __typename: 'MarketCatalog' }
        & Pick<AdminTypes.MarketCatalog, 'id' | 'title'>
        & { markets: { nodes: Array<{ conditions?: AdminTypes.Maybe<{ regionsCondition?: AdminTypes.Maybe<{ regions: { nodes: Array<Pick<AdminTypes.MarketRegionCountry, 'code'>> } }> }> }> } }
      )> }
    )> } };

export type AnchorPriceListPricesQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type AnchorPriceListPricesQuery = { priceList?: AdminTypes.Maybe<(
    Pick<AdminTypes.PriceList, 'id'>
    & { prices: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
        Pick<AdminTypes.PriceListPrice, 'originType'>
        & { variant: Pick<AdminTypes.ProductVariant, 'id'>, price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, compareAtPrice?: AdminTypes.Maybe<Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>> }
      )> } }
  )> };

export type AnchorAuditVariantsQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AnchorAuditVariantsQuery = { nodes: Array<AdminTypes.Maybe<Pick<AdminTypes.ProductVariant, 'id' | 'price' | 'compareAtPrice'>>> };

export type SeedProductSetMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductSetInput;
}>;


export type SeedProductSetMutation = { productSet?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id'>>, userErrors: Array<Pick<AdminTypes.ProductSetUserError, 'field' | 'message'>> }> };

export type SeedExistingQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SeedExistingQuery = { products: { nodes: Array<Pick<AdminTypes.Product, 'handle'>>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type SeedCollectionByHandleQueryVariables = AdminTypes.Exact<{
  handle: AdminTypes.Scalars['String']['input'];
}>;


export type SeedCollectionByHandleQuery = { collectionByHandle?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id'>> };

export type SeedCollectionCreateMutationVariables = AdminTypes.Exact<{
  collection: AdminTypes.CollectionCreateInput;
}>;


export type SeedCollectionCreateMutation = { collectionCreate?: AdminTypes.Maybe<{ collection?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type SeedStagedUploadMutationVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type SeedStagedUploadMutation = { stagedUploadsCreate?: AdminTypes.Maybe<{ stagedTargets?: AdminTypes.Maybe<Array<(
      Pick<AdminTypes.StagedMediaUploadTarget, 'url'>
      & { parameters: Array<Pick<AdminTypes.StagedUploadParameter, 'name' | 'value'>> }
    )>>, userErrors: Array<Pick<AdminTypes.UserError, 'message'>> }> };

export type SeedBulkRunMutationVariables = AdminTypes.Exact<{
  mutation: AdminTypes.Scalars['String']['input'];
  path: AdminTypes.Scalars['String']['input'];
}>;


export type SeedBulkRunMutation = { bulkOperationRunMutation?: AdminTypes.Maybe<{ bulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status'>>, userErrors: Array<Pick<AdminTypes.BulkMutationUserError, 'field' | 'message'>> }> };

export type SeedBulkStatusQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type SeedBulkStatusQuery = { currentBulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status' | 'objectCount' | 'errorCode' | 'url' | 'partialDataUrl'>> };

interface GeneratedQueryTypes {
  "#graphql\n  query AnchorCurrentBulkOperation {\n    currentBulkOperation(type: MUTATION) {\n      id status url partialDataUrl objectCount errorCode\n    }\n  }\n": {return: AnchorCurrentBulkOperationQuery, variables: AnchorCurrentBulkOperationQueryVariables},
  "#graphql\n  query AnchorPriceListDerivedPrices($priceListId: ID!, $query: String!, $first: Int!, $after: String) {\n    priceList(id: $priceListId) {\n      currency\n      prices(originType: RELATIVE, query: $query, first: $first, after: $after) {\n        nodes {\n          variant { id }\n          price { amount currencyCode }\n        }\n        pageInfo { hasNextPage endCursor }\n      }\n    }\n  }\n": {return: AnchorPriceListDerivedPricesQuery, variables: AnchorPriceListDerivedPricesQueryVariables},
  "#graphql\n  query AnchorContextualPrices($ids: [ID!]!, $context: ContextualPricingContext!) {\n    nodes(ids: $ids) {\n      ... on ProductVariant {\n        id\n        contextualPricing(context: $context) {\n          price { amount currencyCode }\n          compareAtPrice { amount currencyCode }\n        }\n      }\n    }\n  }\n": {return: AnchorContextualPricesQuery, variables: AnchorContextualPricesQueryVariables},
  "#graphql\n  query AnchorPriceListParent($id: ID!) {\n    priceList(id: $id) {\n      id\n      currency\n      parent {\n        adjustment { type value }\n        settings { compareAtMode }\n      }\n      fixed: prices(originType: FIXED, first: 1) {\n        nodes { variant { id } }\n      }\n    }\n  }\n": {return: AnchorPriceListParentQuery, variables: AnchorPriceListParentQueryVariables},
  "#graphql\n  query AnchorVariantPrices($ids: [ID!]!) {\n    nodes(ids: $ids) {\n      ... on ProductVariant { id price compareAtPrice }\n    }\n  }\n": {return: AnchorVariantPricesQuery, variables: AnchorVariantPricesQueryVariables},
  "#graphql\n      query AnchorProbeMarkets {\n        markets(first: 1) { nodes { id } }\n      }\n    ": {return: AnchorProbeMarketsQuery, variables: AnchorProbeMarketsQueryVariables},
  "#graphql\n      query AnchorProbeCompanies {\n        companies(first: 1) { nodes { id } }\n      }\n    ": {return: AnchorProbeCompaniesQuery, variables: AnchorProbeCompaniesQueryVariables},
  "#graphql\n  query AnchorProductTags($ids: [ID!]!) {\n    nodes(ids: $ids) {\n      ... on Product { id tags }\n    }\n  }\n": {return: AnchorProductTagsQuery, variables: AnchorProductTagsQueryVariables},
  "#graphql\n  query AnchorCurrentBulkQuery {\n    currentBulkOperation(type: QUERY) {\n      id status url partialDataUrl objectCount errorCode\n    }\n  }\n": {return: AnchorCurrentBulkQueryQuery, variables: AnchorCurrentBulkQueryQueryVariables},
  "#graphql\n  query AnchorCatalogPage($cursor: String) {\n    products(first: 50, after: $cursor) {\n      pageInfo { hasNextPage endCursor }\n      nodes {\n        id\n        title\n        vendor\n        productType\n        status\n        tags\n        updatedAt\n        collections(first: 20) { nodes { id } }\n        variants(first: 100) {\n          nodes {\n            id\n            title\n            sku\n            barcode\n            price\n            compareAtPrice\n            inventoryQuantity\n            inventoryItem { unitCost { amount currencyCode } }\n          }\n        }\n      }\n    }\n  }\n": {return: AnchorCatalogPageQuery, variables: AnchorCatalogPageQueryVariables},
  "#graphql\n  query AnchorShopCurrency {\n    shop { currencyCode ianaTimezone }\n  }\n": {return: AnchorShopCurrencyQuery, variables: AnchorShopCurrencyQueryVariables},
  "#graphql\n  query AnchorPriceLists($cursor: String) {\n    priceLists(first: 50, after: $cursor) {\n      pageInfo { hasNextPage endCursor }\n      nodes {\n        id\n        name\n        currency\n        parent { adjustment { type value } }\n        catalog {\n          id\n          title\n          __typename\n          ... on MarketCatalog {\n            # One country this catalogue's market serves.\n            #\n            # Prices are asked for by country rather than by price list, so the market\n            # surface needs a country to ask about. Every country in a market sees the\n            # same price, so the first region answers for all of them.\n            markets(first: 1) {\n              nodes {\n                conditions {\n                  regionsCondition {\n                    regions(first: 1) {\n                      nodes { ... on MarketRegionCountry { code } }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n": {return: AnchorPriceListsQuery, variables: AnchorPriceListsQueryVariables},
  "#graphql\n  query AnchorPriceListPrices($id: ID!, $cursor: String) {\n    priceList(id: $id) {\n      id\n      prices(first: 250, after: $cursor) {\n        pageInfo { hasNextPage endCursor }\n        nodes {\n          originType\n          variant { id }\n          price { amount currencyCode }\n          compareAtPrice { amount currencyCode }\n        }\n      }\n    }\n  }\n": {return: AnchorPriceListPricesQuery, variables: AnchorPriceListPricesQueryVariables},
  "#graphql\n  query AnchorAuditVariants($ids: [ID!]!) {\n    nodes(ids: $ids) {\n      ... on ProductVariant { id price compareAtPrice }\n    }\n  }\n": {return: AnchorAuditVariantsQuery, variables: AnchorAuditVariantsQueryVariables},
  "#graphql\n          query SeedExisting($cursor: String) {\n            products(first: 250, after: $cursor, query: \"handle:anchor-perf-*\") {\n              nodes { handle }\n              pageInfo { hasNextPage endCursor }\n            }\n          }\n        ": {return: SeedExistingQuery, variables: SeedExistingQueryVariables},
  "#graphql\n        query SeedCollectionByHandle($handle: String!) {\n          collectionByHandle(handle: $handle) { id }\n        }\n      ": {return: SeedCollectionByHandleQuery, variables: SeedCollectionByHandleQueryVariables},
  "#graphql\n        query SeedBulkStatus {\n          currentBulkOperation(type: MUTATION) {\n            id status objectCount errorCode url partialDataUrl\n          }\n        }\n      ": {return: SeedBulkStatusQuery, variables: SeedBulkStatusQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n  mutation AnchorStagedUploadsCreate($input: [StagedUploadInput!]!) {\n    stagedUploadsCreate(input: $input) {\n      stagedTargets { url resourceUrl parameters { name value } }\n      userErrors { field message }\n    }\n  }\n": {return: AnchorStagedUploadsCreateMutation, variables: AnchorStagedUploadsCreateMutationVariables},
  "#graphql\n  mutation AnchorBulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {\n    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {\n      bulkOperation { id status url partialDataUrl objectCount }\n      userErrors { field message }\n    }\n  }\n": {return: AnchorBulkOperationRunMutationMutation, variables: AnchorBulkOperationRunMutationMutationVariables},
  "#graphql\n  mutation AnchorPriceListFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {\n    priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {\n      prices { variant { id } price { amount currencyCode } compareAtPrice { amount currencyCode } }\n      userErrors { field message code }\n    }\n  }\n": {return: AnchorPriceListFixedPricesAddMutation, variables: AnchorPriceListFixedPricesAddMutationVariables},
  "#graphql\n  mutation AnchorPriceListFixedPricesDelete($priceListId: ID!, $variantIds: [ID!]!) {\n    priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {\n      deletedFixedPriceVariantIds\n      userErrors { field message code }\n    }\n  }\n": {return: AnchorPriceListFixedPricesDeleteMutation, variables: AnchorPriceListFixedPricesDeleteMutationVariables},
  "#graphql\n  mutation AnchorPriceListUpdate($id: ID!, $input: PriceListUpdateInput!) {\n    priceListUpdate(id: $id, input: $input) {\n      priceList {\n        id\n        parent { adjustment { type value } }\n      }\n      userErrors { field message code }\n    }\n  }\n": {return: AnchorPriceListUpdateMutation, variables: AnchorPriceListUpdateMutationVariables},
  "#graphql\n  mutation AnchorProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n    productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n      productVariants { id price compareAtPrice }\n      userErrors { field message code }\n    }\n  }\n": {return: AnchorProductVariantsBulkUpdateMutation, variables: AnchorProductVariantsBulkUpdateMutationVariables},
  "#graphql\n      mutation AnchorProbeVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n        productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeVariantsBulkUpdateMutation, variables: AnchorProbeVariantsBulkUpdateMutationVariables},
  "#graphql\n      mutation AnchorProbeBulkQuery($query: String!) {\n        bulkOperationRunQuery(query: $query) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeBulkQueryMutation, variables: AnchorProbeBulkQueryMutationVariables},
  "#graphql\n      mutation AnchorProbeBulkMutation($mutation: String!, $stagedUploadPath: String!) {\n        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeBulkMutationMutation, variables: AnchorProbeBulkMutationMutationVariables},
  "#graphql\n      mutation AnchorProbeStagedUploads($input: [StagedUploadInput!]!) {\n        stagedUploadsCreate(input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeStagedUploadsMutation, variables: AnchorProbeStagedUploadsMutationVariables},
  "#graphql\n      mutation AnchorProbePriceListCreate($input: PriceListCreateInput!) {\n        priceListCreate(input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbePriceListCreateMutation, variables: AnchorProbePriceListCreateMutationVariables},
  "#graphql\n      mutation AnchorProbePriceListUpdate($id: ID!, $input: PriceListUpdateInput!) {\n        priceListUpdate(id: $id, input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbePriceListUpdateMutation, variables: AnchorProbePriceListUpdateMutationVariables},
  "#graphql\n      mutation AnchorProbeFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {\n        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeFixedPricesAddMutation, variables: AnchorProbeFixedPricesAddMutationVariables},
  "#graphql\n      mutation AnchorProbeFixedPricesDelete($priceListId: ID!, $variantIds: [ID!]!) {\n        priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeFixedPricesDeleteMutation, variables: AnchorProbeFixedPricesDeleteMutationVariables},
  "#graphql\n      mutation AnchorProbeQuantityPricing($priceListId: ID!, $input: QuantityPricingByVariantUpdateInput!) {\n        quantityPricingByVariantUpdate(priceListId: $priceListId, input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeQuantityPricingMutation, variables: AnchorProbeQuantityPricingMutationVariables},
  "#graphql\n      mutation AnchorProbeCatalogCreate($input: CatalogCreateInput!) {\n        catalogCreate(input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeCatalogCreateMutation, variables: AnchorProbeCatalogCreateMutationVariables},
  "#graphql\n      mutation AnchorProbeCatalogUpdate($id: ID!, $input: CatalogUpdateInput!) {\n        catalogUpdate(id: $id, input: $input) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeCatalogUpdateMutation, variables: AnchorProbeCatalogUpdateMutationVariables},
  "#graphql\n      mutation AnchorProbeTagsAdd($id: ID!, $tags: [String!]!) {\n        tagsAdd(id: $id, tags: $tags) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeTagsAddMutation, variables: AnchorProbeTagsAddMutationVariables},
  "#graphql\n      mutation AnchorProbeTagsRemove($id: ID!, $tags: [String!]!) {\n        tagsRemove(id: $id, tags: $tags) {\n          userErrors { field message }\n        }\n      }\n    ": {return: AnchorProbeTagsRemoveMutation, variables: AnchorProbeTagsRemoveMutationVariables},
  "#graphql\n  mutation AnchorTagsAdd($id: ID!, $tags: [String!]!) {\n    tagsAdd(id: $id, tags: $tags) {\n      node { id }\n      userErrors { field message }\n    }\n  }\n": {return: AnchorTagsAddMutation, variables: AnchorTagsAddMutationVariables},
  "#graphql\n  mutation AnchorTagsRemove($id: ID!, $tags: [String!]!) {\n    tagsRemove(id: $id, tags: $tags) {\n      node { id }\n      userErrors { field message }\n    }\n  }\n": {return: AnchorTagsRemoveMutation, variables: AnchorTagsRemoveMutationVariables},
  "#graphql\n  mutation AnchorCatalogBulkQuery($query: String!) {\n    bulkOperationRunQuery(query: $query) {\n      bulkOperation { id status }\n      userErrors { field message }\n    }\n  }\n": {return: AnchorCatalogBulkQueryMutation, variables: AnchorCatalogBulkQueryMutationVariables},
  "#graphql\n  mutation AnchorFlowTriggerReceive($handle: String!, $payload: JSON!) {\n    flowTriggerReceive(handle: $handle, payload: $payload) {\n      userErrors { field message }\n    }\n  }\n": {return: AnchorFlowTriggerReceiveMutation, variables: AnchorFlowTriggerReceiveMutationVariables},
  "#graphql\n  mutation SeedProductSet($input: ProductSetInput!) {\n    productSet(input: $input) {\n      product { id }\n      userErrors { field message }\n    }\n  }\n": {return: SeedProductSetMutation, variables: SeedProductSetMutationVariables},
  "#graphql\n        mutation SeedCollectionCreate($collection: CollectionCreateInput!) {\n          collectionCreate(collection: $collection) {\n            collection { id }\n            userErrors { field message }\n          }\n        }\n      ": {return: SeedCollectionCreateMutation, variables: SeedCollectionCreateMutationVariables},
  "#graphql\n      mutation SeedStagedUpload {\n        stagedUploadsCreate(input: [{\n          resource: BULK_MUTATION_VARIABLES,\n          filename: \"seed.jsonl\",\n          mimeType: \"text/jsonl\",\n          httpMethod: POST\n        }]) {\n          stagedTargets { url parameters { name value } }\n          userErrors { message }\n        }\n      }\n    ": {return: SeedStagedUploadMutation, variables: SeedStagedUploadMutationVariables},
  "#graphql\n      mutation SeedBulkRun($mutation: String!, $path: String!) {\n        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {\n          bulkOperation { id status }\n          userErrors { field message }\n        }\n      }\n    ": {return: SeedBulkRunMutation, variables: SeedBulkRunMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
