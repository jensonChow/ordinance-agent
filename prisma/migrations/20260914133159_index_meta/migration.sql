-- CreateTable
CREATE TABLE "IndexMeta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexMeta_pkey" PRIMARY KEY ("key")
);
