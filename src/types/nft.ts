export type NFT = {
  // id crafted by live
  id: string;
  // id on chain
  tokenId: string;
  nftName: string | null;
  // url
  picture: string | null;
  description: string | null;
  properties: Record<string, string> | null;
  collection: {
    contract: string;
    tokenName: string | null;
    contractSpec: "ERC721" | "ERC1155";
  };
};

export type NFTMetadataProviders = "openSea";

export type NFTMetadata = {
  contract: string;
  tokenId: string;
  tokenName: string | null;
  nftName: string | null;
  picture: string | null;
  description: string | null;
  /** @warning properties is not in the OpenAPI at this stage ? */
  properties?: Record<string, string>;
  links: Record<NFTMetadataProviders, string>;
};
