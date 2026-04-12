CREATE INDEX IF NOT EXISTS hourly_sales_restaurant_date_idx ON hourly_sales (restaurant_id, sales_date);
CREATE INDEX IF NOT EXISTS hourly_sales_date_idx ON hourly_sales (sales_date);
